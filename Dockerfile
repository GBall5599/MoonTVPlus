# ---- 公共基础层：固定 pnpm 版本 + 共享 pnpm store ----
#
# 【为什么要有这一层】2026-09-17 实测：一次完整构建约 10 分钟，最长的一段不是
# next build（约 90 秒），而是 `pnpm deploy --prod` 的 **354 秒**。原因不是 deploy
# 慢，而是**它在 builder 阶段看不到 pnpm 的 store**：
#   · deps 阶段 `pnpm install` 只把 /app/node_modules 复制给 builder；
#   · 而 pnpm 的内容寻址存储（store）默认在 /app 之外（~/.local/share/pnpm/store），
#     并不在被复制的东西里；
#   · 于是 deploy 认定"本地一个包都没有"，把整棵依赖树重新下载了一遍 ——
#     构建日志里 `resolved 2405, reused 0, downloaded 2192` 就是铁证。
#
# 修法：把 store 挂成 BuildKit 缓存（`--mount=type=cache,id=pnpm-store`），
# deps 与 builder 两个阶段共用同一份，deploy 就退化成"从 store 取包"，
# 不再产生下载。缓存挂载**不写进镜像层**，所以最终镜像体积不变。
#
# 两点说明：
#   1. 缓存目录与 /app 一般不在同一个挂载点，跨设备硬链接会失败，此时 pnpm 会
#      自动降级为复制（package-import-method 默认 auto）—— 仍然比联网下载快一个量级。
#   2. store 会占本机 builder 缓存（GB 级）。要清：`docker builder prune`。
#
# 版本固定成 pnpm@10.14.0（原来写 @latest）：@latest 每个阶段都要联网解析一次，
# 既是额外耗时，也是"registry 抽风导致构建静默卡住"的来源之一。
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
# 两条都设：配置文件对所有 pnpm 子命令（含 deploy 内部再起的安装）生效，
# 环境变量兜底。只设其一也可以，但 store 没生效的代价是"又慢 6 分钟"，值得冗余。
RUN pnpm config set store-dir /pnpm-store --global
ENV npm_config_store_dir=/pnpm-store

# ---- 第 1 阶段：安装依赖 ----
FROM base AS deps

WORKDIR /app

# 仅复制依赖清单，提高构建缓存利用率
COPY package.json pnpm-lock.yaml ./

# 安装所有依赖（含 devDependencies，后续会裁剪）
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
  pnpm install --frozen-lockfile

# ---- 第 2 阶段：构建项目 ----
FROM base AS builder
WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
# 复制全部源代码
COPY . .

# 在构建阶段也显式设置 DOCKER_ENV，
ENV DOCKER_ENV=true

# 生成生产构建
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
  pnpm run build

# 使用 pnpm deploy 提取生产依赖到独立目录。
# ⚠ 必须和 deps 阶段挂同一个 store，否则这里会变成"重新下载 2192 个包"（实测 354 秒）。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
  pnpm deploy --filter=. --prod --legacy /tmp/prod-deps

# ---- 第 3 阶段：生成运行时镜像 ----
FROM base AS runner

# 安装 su-exec，用于在 entrypoint 中降权运行
RUN apk add --no-cache su-exec

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# 复制 entrypoint（支持通过 PUID/PGID 环境变量指定运行 UID/GID）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
ENV SQLITE_DB_PATH=/app/.data/moontv.db
ENV OFFLINE_DOWNLOAD_DIR=/data

# 从构建器中复制 standalone 输出
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 从构建器中复制 scripts 目录
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# 从构建器中复制 migrations 目录
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
# 从构建器中复制 start.js
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
# 从构建器中复制自定义 server.js（包含 Socket.IO 支持）
COPY --from=builder --chown=nextjs:nodejs /app/server.js ./server.js
# 自定义 server.js 在运行时会 require('./src/lib/tv-remote-hub.js')。
# Next standalone 只会追踪 Next 应用入口，不会自动包含自定义服务器额外 require 的源文件，
# 因此需要显式复制该运行时模块，避免生产镜像启动时报 Cannot find module。
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/tv-remote-hub.js ./src/lib/tv-remote-hub.js
# 从构建器中复制 public 和 .next/static 目录
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 从构建器中复制生产依赖（包含 Socket.IO / better-sqlite3）
COPY --from=builder --chown=nextjs:nodejs /tmp/prod-deps/node_modules ./node_modules

# 准备 SQLite 数据目录和默认离线下载目录
RUN mkdir -p /app/.data "$OFFLINE_DOWNLOAD_DIR" \
  && chown -R nextjs:nodejs /app/.data "$OFFLINE_DOWNLOAD_DIR"

# 默认以 root 启动，由 entrypoint 按 PUID/PGID 环境变量调整后降权运行
EXPOSE 3000

# 使用自定义启动脚本，先预加载配置再启动服务器
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "start.js"]
