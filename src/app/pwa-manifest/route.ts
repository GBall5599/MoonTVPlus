/**
 * PWA manifest —— 在**请求时**生成，而不是构建时。
 *
 * 为什么不用 public/manifest.json（那个文件仍然保留，作为静态回退）：
 *   `scripts/generate-manifest.js` 在 `pnpm run build` 时跑，
 *   站点名在那一刻就被写死了。于是：
 *     - 用户拉官方 Docker 镜像部署时，镜像里编的是默认名 `MoonTVPlus`；
 *       用户在 .env 里设 NEXT_PUBLIC_SITE_NAME 只影响服务端渲染的网页，
 *       **改不动 manifest** —— PWA 装到手机桌面后名字还是 MoonTVPlus。
 *     - 本地开发时若忘了先导出变量再 gen:manifest，同样残留默认名。
 *
 *   放在路由里改成动态读取 process.env.*，三种部署方式（Docker / 源码 /
 *   本地）都能正确反映品牌名，不再依赖构建顺序。
 *
 * 说明：这个路径不在 /api/ 下，且 next.config.js 没有 i18n，
 *       因此不会被 middleware 的鉴权 matcher 命中
 *       （middleware.ts 的跳过名单里也已经有 /manifest.json）。
 *       另外公开读、无副作用，无需鉴权。
 */

import { NextResponse } from 'next/server';

// 每次都重新读环境变量，绝不被静态化
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  // 服务端环境里能拿到运行时注入的值
  const siteName = process.env.NEXT_PUBLIC_SITE_NAME || 'MoonTVPlus';

  const manifest = {
    name: siteName,
    short_name: siteName,
    description: '影视聚合',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#000000',
    icons: [
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-256x256.png', sizes: '256x256', type: 'image/png' },
      { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };

  return NextResponse.json(manifest, {
    headers: {
      // manifest 不含敏感信息，可短缓存；用户改品牌名后最多 5 分钟生效
      'Cache-Control': 'public, max-age=300',
    },
  });
}
