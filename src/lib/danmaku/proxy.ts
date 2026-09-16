/**
 * 弹幕服务代理：**带备用源的有序降级**。
 *
 * 四个弹幕路由（search / match / episodes / comment）都走这里，不再自己 fetch。
 * 为什么要这层：2026-09-16 弹幕整体不可用，根因是默认指向的第三方共享服务
 * 额度用尽返回 503 —— 单点挂了，前端只会显示"一片干净"，没有任何提示。
 * 现在：主源不通自动换下一个候选（见 config.ts 的顺序），并在容器日志里
 * 明确写出"降级到谁、前面几个因为什么失败"。
 *
 * 降级判据（重要，别乱改）：
 *  · **值得换源**：网络错误 / 超时 / 5xx / 429 / 404 —— 说明这个源不行；
 *  · **不值得换源**：其余 4xx —— 说明请求本身有问题，换谁来都一样，
 *    直接返回，免得把"参数错了"伪装成"备用源也挂了"误导排查。
 *
 * 日志只打 `协议+主机`（safeOrigin），**绝不带令牌路径**。
 */
import type { AdminConfig } from '@/lib/admin.types';

import { getDanmakuApiBaseUrls } from './config';

export interface DanmakuAttempt {
  /** 协议 + 主机，不含令牌路径 */
  host: string;
  reason: string;
}

export interface DanmakuFetchResult {
  ok: boolean;
  status: number;
  /** 原始响应体文本（可能是 XML） */
  text: string;
  /** 命中的源（协议+主机）；全部失败时为空串 */
  sourceOrigin: string;
  attempts: DanmakuAttempt[];
}

export interface DanmakuFetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  accept?: string;
  timeoutMs?: number;
  /** 日志标签（搜索/剧集/弹幕/匹配），便于在容器日志里对号入座 */
  label?: string;
}

function safeOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return '(地址不合法)';
  }
}

function worthTryingNext(status: number): boolean {
  return status >= 500 || status === 429 || status === 404;
}

export async function fetchFromDanmaku(
  siteConfig: AdminConfig['SiteConfig'],
  path: string,
  options: DanmakuFetchOptions = {}
): Promise<DanmakuFetchResult> {
  const bases = getDanmakuApiBaseUrls(siteConfig);
  const timeoutMs = options.timeoutMs ?? 12000;
  const label = options.label || path;
  const attempts: DanmakuAttempt[] = [];
  let last = { status: 0, text: '' };

  for (const base of bases) {
    const origin = safeOrigin(base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: options.method || 'GET',
        headers:
          options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : { Accept: options.accept || 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        keepalive: true,
      });
      clearTimeout(timer);
      const text = await response.text();

      if (response.ok) {
        if (attempts.length) {
          console.warn(
            `[弹幕] ${label}：前 ${attempts.length} 个源不可用（${attempts
              .map((a) => `${a.host} ${a.reason}`)
              .join('；')}），已降级到 ${origin}`
          );
        }
        return {
          ok: true,
          status: response.status,
          text,
          sourceOrigin: origin,
          attempts,
        };
      }

      last = { status: response.status, text };
      attempts.push({ host: origin, reason: `HTTP ${response.status}` });

      if (!worthTryingNext(response.status)) {
        console.warn(
          `[弹幕] ${label}：${origin} 返回 HTTP ${response.status} —— 请求本身有问题，不再换源`
        );
        return {
          ok: false,
          status: response.status,
          text,
          sourceOrigin: origin,
          attempts,
        };
      }
    } catch (error) {
      clearTimeout(timer);
      const err = error as Error;
      const reason =
        err?.name === 'AbortError'
          ? `超时 ${timeoutMs}ms`
          : `${err?.name || 'Error'}: ${err?.message || ''}`;
      attempts.push({ host: origin, reason });
      last = { status: 0, text: reason };
    }
  }

  console.error(
    `[弹幕] ${label}：${bases.length} 个候选源全部失败 —— ${attempts
      .map((a) => `${a.host} ${a.reason}`)
      .join('；')}`
  );
  return {
    ok: false,
    status: last.status || 502,
    text: last.text,
    sourceOrigin: '',
    attempts,
  };
}

/** 全挂时给前端的一句话（带上每跳原因，便于用户直接反馈） */
export function danmakuFailureMessage(result: DanmakuFetchResult): string {
  if (!result.attempts.length) return '弹幕服务不可用';
  return `弹幕服务不可用（${result.attempts.map((a) => a.reason).join('；')}）`;
}
