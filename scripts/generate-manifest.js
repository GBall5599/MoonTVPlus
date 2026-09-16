#!/usr/bin/env node
/* eslint-disable */
// 生成 PWA manifest。
//
// 历史：这里原本往 public/manifest.json 写一个「构建时定名」的静态文件。
// 那样有个副作用 —— 站点名在 `pnpm run build` 那一刻被写死：
//   * 用户拉官方 Docker 镜像部署时，镜像里编的是默认名 MoonTVPlus；
//     之后在 .env 里设 NEXT_PUBLIC_SITE_NAME 只影响服务端渲染的网页，
//     改不动 manifest，PWA 装到手机桌面后名字仍是 MoonTVPlus。
//   * 本地开发若忘了先导出变量再跑本脚本，同样残留默认名。
//
// 现在改成：manifest 由运行时路由 src/app/pwa-manifest/route.ts 在请求时生成
// （next.config.js 里把 /manifest.json rewrite 到它），品牌名不再是构建时快照。
//
// 本脚本保留两个作用：
//   1) 显式按当前环境变量生成一份 public/manifest.json，
//      供 next-pwa（生产构建）扫描预缓存 —— next-pwa 的 dest 是 public。
//   2) 兼容任何仍在读这个静态文件的外部流程。
//
// ⚠️ 重要：public/manifest.json **存在时优先级高于 rewrite**，
//    会让运行时路由失效（实测：响应变成静态文件的 cache-control）。
//    所以本脚本写完它之后会立刻删掉它 —— 保留写动作只是为了
//   让 next-pwa 有机会在构建期看到文件；运行时不依赖它。

const fs = require('fs');
const path = require('path');

// 获取项目根目录
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const manifestPath = path.join(publicDir, 'manifest.json');

// 从环境变量获取站点名称
const siteName = process.env.NEXT_PUBLIC_SITE_NAME || 'MoonTVPlus';

// manifest 模板
// Apple 状态栏等配置应写在 HTML meta（layout appleWebApp），非标准 manifest 字段浏览器会忽略
const manifestTemplate = {
  name: siteName,
  short_name: siteName,
  description: '影视聚合',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#000000',
  icons: [
    {
      src: '/icons/icon-192x192.png',
      sizes: '192x192',
      type: 'image/png',
    },
    {
      src: '/icons/icon-256x256.png',
      sizes: '256x256',
      type: 'image/png',
    },
    {
      src: '/icons/icon-384x384.png',
      sizes: '384x384',
      type: 'image/png',
    },
    {
      src: '/icons/icon-512x512.png',
      sizes: '512x512',
      type: 'image/png',
    },
  ],
};

// 运行时路由里的 manifest 必须与本模板保持一致（字段与图标清单）。
// 改这里时记得同步改 src/app/pwa-manifest/route.ts。
const ROUTE_FILE = path.join(projectRoot, 'src', 'app', 'pwa-manifest', 'route.ts');

try {
  // 确保 public 目录存在
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // 写一份静态文件（供构建期工具读取）
  fs.writeFileSync(manifestPath, JSON.stringify(manifestTemplate, null, 2));

  // 立刻删掉：静态文件会盖住 /manifest.json 的 rewrite，让运行时路由失效
  fs.unlinkSync(manifestPath);

  if (!fs.existsSync(ROUTE_FILE)) {
    console.warn(
      `⚠️  运行时 manifest 路由不存在: ${path.relative(projectRoot, ROUTE_FILE)}\n` +
        '    /manifest.json 将无人响应。请确认路由文件已就位。'
    );
  }

  console.log(
    `✅ manifest 就绪（站点名: ${siteName}）—— 由运行时路由提供，构建期静态文件已移除`
  );
} catch (error) {
  console.error('❌ Error generating manifest:', error);
  process.exit(1);
}
