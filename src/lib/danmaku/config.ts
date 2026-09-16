import type { AdminConfig } from '@/lib/admin.types';

export const BUILTIN_DANMAKU_API_BASE = 'https://mtvpls-danmu.netlify.app/87654321';
export const BUILTIN_DANMAKU_API_TOKEN = '87654321';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

/**
 * 把令牌拼进单个基址。约定与上游一致：
 *  · 内置源地址里**已经含**令牌，不再拼；
 *  · 令牌仍是默认的 87654321 时可以省略（弹幕服务允许不带令牌访问）。
 */
function withToken(base: string, token: string) {
  const b = trimTrailingSlash(base);
  if (b === trimTrailingSlash(BUILTIN_DANMAKU_API_BASE)) return b;
  if (!token || token === BUILTIN_DANMAKU_API_TOKEN) return b;
  return b.endsWith(`/${token}`) ? b : `${b}/${token}`;
}

/** 不改库也能加备胎：环境变量 DANMAKU_FALLBACK_BASES（逗号分隔） */
function envFallbackBases(): string[] {
  return String(process.env.DANMAKU_FALLBACK_BASES || '')
    .split(',')
    .map((s) => trimTrailingSlash(s.trim()))
    .filter((s) => /^https?:\/\//i.test(s));
}

/**
 * 有序候选源列表（去重保序）。**这是弹幕"备用源"机制的唯一真相**。
 *
 * 顺序：
 *   1. 后台配置的主源 —— `DanmakuApiBase` 支持**逗号分隔多个**，按书写顺序依次尝试；
 *   2. 环境变量 `DANMAKU_FALLBACK_BASES` 追加的备源（换备胎不用重新构建镜像）；
 *   3. 上游内置共享源（现在多半是挂的，但它可能恢复，放最后不花钱）。
 *
 * 为什么不做成"挂公共源兜底"：2026-09-16 实测过 6 个公共弹幕 API
 * （api.danmu.icu / dmku.hls.one / fc.lyz05.cn / se.678.ooo / danmu.56uxi.com /
 * dm.lxlad.com），从本站服务器**全部不可用**（连不上 / 403 人机校验 / 协议不兼容）。
 * 所以真正能兜住的只有"自己的第二个实例"。
 */
export function getDanmakuApiBaseUrls(
  siteConfig: AdminConfig['SiteConfig']
): string[] {
  const list: string[] = [];

  if (siteConfig.DanmakuSourceType === 'builtin') {
    list.push(trimTrailingSlash(BUILTIN_DANMAKU_API_BASE));
  } else {
    const token = (siteConfig.DanmakuApiToken || BUILTIN_DANMAKU_API_TOKEN).trim();
    const raw = String(siteConfig.DanmakuApiBase || 'http://localhost:9321')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s));
    for (const base of raw) list.push(withToken(base, token));
  }

  list.push(...envFallbackBases());
  list.push(trimTrailingSlash(BUILTIN_DANMAKU_API_BASE));

  // 去重保序（不用 [...new Set()]：本项目 tsconfig 的 target 下不支持迭代 Set）
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const base of list) {
    if (seen.has(base)) continue;
    seen.add(base);
    unique.push(base);
  }
  return unique;
}

/** 兼容旧调用：拿第一个候选（主源）。 */
export function getDanmakuApiBaseUrl(siteConfig: AdminConfig['SiteConfig']) {
  return getDanmakuApiBaseUrls(siteConfig)[0];
}
