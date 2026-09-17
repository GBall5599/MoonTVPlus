/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');
const path = require('path');

// 检测是否为边缘平台构建
const isCloudflare = process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';
const isEdgeOne = process.env.EDGEONE_PAGES === '1' || process.env.BUILD_TARGET === 'edgeone';
const isEdgeBuild = isCloudflare || isEdgeOne;

const optimizedPackageImports = [
  '@dnd-kit/core',
  '@dnd-kit/modifiers',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@heroicons/react',
  'lucide-react',
  'react-icons',
];

const createNextConfig = (phase) => {
  const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER || process.env.NODE_ENV === 'development';

  const nextConfig = {
  // Cloudflare Pages 不支持 standalone，使用默认输出
  output: isEdgeBuild ? undefined : 'standalone',

  // 把 /manifest.json 交给运行时路由（src/app/pwa-manifest/route.ts）。
  //
  // 为什么需要这一步：
  //   public/manifest.json 是 scripts/generate-manifest.js 在 `pnpm run build` 时
  //   按当时的环境变量生成的 —— 站点名在那一刻就被写死了。
  //   用户拉官方 Docker 镜像部署时，镜像里编的是默认名 MoonTVPlus，
  //   之后在 .env 里设 NEXT_PUBLIC_SITE_NAME 只影响服务端渲染的网页，
  //   改不动 manifest，于是 PWA 装到手机桌面后名字仍是 MoonTVPlus。
  //
  //   rewrite 到动态路由后，三种部署方式（Docker / 源码 / 本地）
  //   都能在请求时读到当前品牌名，不再依赖构建顺序。
  //
  // 注意：路由目录必须叫不带点号的段名（pwa-manifest）。
  //   最初建在 app/manifest.json/route.ts 是错的 —— 含点号的目录名不被识别为路由，
  //   还和 public/manifest.json 撞车，实测直接 500。
  async rewrites() {
    return [{ source: '/manifest.json', destination: '/pwa-manifest' }];
  },

  eslint: {
    dirs: ['src'],
    // 在生产构建时忽略 ESLint 错误
    ignoreDuringBuilds: true,
  },

  reactStrictMode: false,
  swcMinify: true,

  // OpenNext/esbuild 使用 workerd condition 解析依赖。
  // @libsql/* 等包有 workerd 专用入口（如 web.cjs），Next NFT 默认只追踪 node 入口，
  // 导致 .open-next 里缺少 web.cjs 并报 Could not resolve "@libsql/isomorphic-ws"。
  // 声明为 server external 后，OpenNext 会完整拷贝这些包并应用 workerd 导出。
  // 参见: https://opennext.js.org/cloudflare/howtos/workerd
  serverExternalPackages: [
    '@libsql/client',
    '@libsql/hrana-client',
    '@libsql/isomorphic-ws',
    '@libsql/isomorphic-fetch',
    'libsql',
  ],

  experimental: {
    instrumentationHook: process.env.NODE_ENV === 'production' && !isEdgeBuild,
    optimizePackageImports: optimizedPackageImports,
    webpackBuildWorker: !isEdgeBuild,
    // Next 14.2 仍可能读取此字段；与 serverExternalPackages 保持一致
    serverComponentsExternalPackages: [
      '@libsql/client',
      '@libsql/hrana-client',
      '@libsql/isomorphic-ws',
      '@libsql/isomorphic-fetch',
      'libsql',
    ],
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config, { isServer }) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    // Cloudflare 使用 D1，不需要把 better-sqlite3 原生模块带入 Worker 产物。
    if (isEdgeBuild) {
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(
          [
            'better-sqlite3',
            'sharp',
            'nodemailer',
            'socket.io',
            'redis',
            '@vercel/postgres',
            'pg',
            'libsql',
            '@libsql/isomorphic-fetch',
            '@libsql/isomorphic-ws',
          ].map((pkg) => [
            pkg,
            path.resolve(
              __dirname,
              'src/lib/cloudflare-shims/node-unsupported.ts'
            ),
          ])
        ),
        // Cloudflare Workers 有原生 fetch；代理 Agent 在 Workers 中不可用。
        // 用轻量 shim 替换 node-fetch / https-proxy-agent，避免把 Node HTTP 栈打入 Worker。
        'node-fetch': path.resolve(
          __dirname,
          'src/lib/cloudflare-shims/node-fetch.ts'
        ),
        ...(isCloudflare
          ? {
              'https-proxy-agent': path.resolve(
                __dirname,
                'src/lib/cloudflare-shims/https-proxy-agent.ts'
              ),
            }
          : {}),
        // opencc-js 字典体积巨大（~1.9MB），仅客户端繁简转换需要。
        // server 构建用空实现 shim 替换，避免字典内联进 Worker；client 构建用真库。
        ...(isCloudflare && isServer
          ? {
              'opencc-js': path.resolve(
                __dirname,
                'src/lib/cloudflare-shims/opencc-js.ts'
              ),
            }
          : {}),
      };
      config.externals = (config.externals || []).filter((external) => {
        return !(
          external &&
          typeof external === 'object' &&
          Object.prototype.hasOwnProperty.call(external, 'better-sqlite3')
        );
      });
    }

    // Exclude better-sqlite3, D1, Postgres, and Turso modules from client-side bundle
    if (!isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'better-sqlite3': 'commonjs better-sqlite3',
        '@vercel/postgres': 'commonjs @vercel/postgres',
        'pg': 'commonjs pg',
        '@libsql/client': 'commonjs @libsql/client',
      });

      config.resolve.alias = {
        ...config.resolve.alias,
        'better-sqlite3': false,
        '@/lib/d1.db': false,
        '@/lib/d1-adapter': false,
        '@/lib/postgres.db': false,
        '@/lib/postgres-adapter': false,
        '@/lib/turso-adapter': false,
      };
    }

    return config;
  },
};

  // next-pwa runs an additional webpack pass that is not needed for the
  // Cloudflare/OpenNext worker bundle and can make Cloudflare builds fail with
  // a generic "Build failed because of webpack errors" message.
  if (isDevelopment || isEdgeBuild) {
    return nextConfig;
  }

  const withPWA = require('next-pwa')({
    dest: 'public',
    register: true,
    skipWaiting: true,
    importScripts: ['/push-sw.js'],
    // ⚠ 关掉 next-pwa 的默认运行时缓存表（defaultCache），这是**必须的**，原因：
    //
    // defaultCache 会给三类请求都套上 `NetworkFirst + networkTimeoutSeconds: 10`：
    //   1. 同源非 API 的 GET —— **包含整页导航**；
    //   2. `/api/*`（GET）；
    //   3. 所有跨域 GET（含豆瓣/CMS 的海报图）。
    // 含义是：**只要 10 秒内没回应，Service Worker 就中止这次请求**，然后回退到缓存；
    // 缓存里没有就直接失败。而本站大量请求本来就是"慢但会成功"的：
    // 播放页要现场去 CMS 抓详情（慢源 10~20 秒）、弹幕冷取一集 7~8 秒、
    // 海报图床在高峰期也会打嗝。于是表现为：
    //   · 点影片 → 导航被中止 → 浏览器报「访问失败 / 连接已重置」；
    //   · 右上角反复弹「后台同步播放记录失败」（/api/playrecords 被中止）；
    //   · 部分封面裂开（跨域图被中止，缓存里又没有）。
    // 另外这些缓存还会**留下 24 小时的陈旧响应**（API/页面都在内），
    // 造成"看到的数据不对、界面像旧版本"。
    //
    // 置空后 SW 只保留 precache（预缓存静态资源），离线静态资源、PWA 安装、
    // push-sw.js 推送都不受影响；所有请求走网络，超时规则回归浏览器默认
    // （宽松得多，不会再出现"9 秒成功却被判失败"）。
    runtimeCaching: [],
  });

  return withPWA(nextConfig);
};

module.exports = createNextConfig;
