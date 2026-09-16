/**
 * 弹幕备用源机制的行为契约测试。
 *
 * 为什么值得锁住：2026-09-16 弹幕整体不可用，根因是唯一数据源额度用尽返回 503，
 * 而代码里**没有任何降级路径**，前端只表现为"一片干净"。这组测试锁的是：
 *  · 候选源顺序与令牌拼接规则（config.ts）
 *  · 什么情况下该换源、什么情况下不该换（proxy.ts）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { BUILTIN_DANMAKU_API_BASE, getDanmakuApiBaseUrls } from '@/lib/danmaku/config';
import { fetchFromDanmaku } from '@/lib/danmaku/proxy';

const BUILTIN_TRIMMED = BUILTIN_DANMAKU_API_BASE.replace(/\/+$/, '');

const site = (over: Record<string, unknown> = {}) =>
  ({
    DanmakuSourceType: 'custom',
    DanmakuApiBase: 'http://a.local:9321',
    DanmakuApiToken: 'sekret',
    ...over,
  }) as any;

/** 简易 fetch 替身：handler 返回 { status, body } 或直接抛 Error */
function mockFetch(handler: (url: string, init?: any) => any) {
  const fn = jest.fn(async (url: string, init?: any) => {
    const r = handler(String(url), init);
    if (r instanceof Error) throw r;
    const status: number = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.body ?? '',
    } as any;
  });
  (global as any).fetch = fn;
  return fn;
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  delete process.env.DANMAKU_FALLBACK_BASES;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getDanmakuApiBaseUrls —— 候选源顺序', () => {
  it('自定义源：主源拼上令牌，最后补上游内置源', () => {
    const urls = getDanmakuApiBaseUrls(site());
    expect(urls).toEqual(['http://a.local:9321/sekret', BUILTIN_TRIMMED]);
  });

  it('令牌为默认值时省略令牌路径（弹幕服务允许不带令牌）', () => {
    const urls = getDanmakuApiBaseUrls(site({ DanmakuApiToken: '87654321' }));
    expect(urls[0]).toBe('http://a.local:9321');
  });

  it('支持逗号分隔多个源，按书写顺序依次兜底（备用实例就靠这个）', () => {
    const urls = getDanmakuApiBaseUrls(
      site({ DanmakuApiBase: 'http://a.local:9321, http://b.local:9321' })
    );
    expect(urls).toEqual([
      'http://a.local:9321/sekret',
      'http://b.local:9321/sekret',
      BUILTIN_TRIMMED,
    ]);
  });

  it('基址已含令牌时不重复拼', () => {
    const urls = getDanmakuApiBaseUrls(site({ DanmakuApiBase: 'http://a.local:9321/sekret' }));
    expect(urls[0]).toBe('http://a.local:9321/sekret');
  });

  it('内置模式只指向内置源（外加可能的环境变量备源）', () => {
    const urls = getDanmakuApiBaseUrls(site({ DanmakuSourceType: 'builtin' }));
    expect(urls).toEqual([BUILTIN_TRIMMED]);
  });

  it('环境变量 DANMAKU_FALLBACK_BASES 可追加备源，且自动去重', () => {
    process.env.DANMAKU_FALLBACK_BASES = 'http://c.local:9321/, http://a.local:9321/sekret, 不是地址';
    const urls = getDanmakuApiBaseUrls(site());
    expect(urls).toEqual([
      'http://a.local:9321/sekret',
      'http://c.local:9321',
      BUILTIN_TRIMMED,
    ]);
  });
});

describe('fetchFromDanmaku —— 降级行为', () => {
  it('主源连不上 → 自动用备用源，并留下降级日志', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.startsWith('http://a.local:9321')) {
        return Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
      }
      return { status: 200, body: '{"animes":[]}' };
    });

    const result = await fetchFromDanmaku(
      site({ DanmakuApiBase: 'http://a.local:9321,http://b.local:9321' }),
      '/api/v2/search/anime?keyword=x',
      { label: '搜索' }
    );

    expect(result.ok).toBe(true);
    expect(result.sourceOrigin).toBe('http://b.local:9321');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].reason).toContain('ECONNREFUSED');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('已降级到 http://b.local:9321'));
    // 日志与 attempts 里都不能出现令牌
    expect(JSON.stringify(result.attempts)).not.toContain('sekret');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('主源返回 503 → 换下一个（额度用尽正是这个形态）', async () => {
    mockFetch((url) =>
      url.startsWith('http://a.local:9321')
        ? { status: 503, body: '{"error":"usage_exceeded"}' }
        : { status: 200, body: '{"animes":[]}' }
    );
    const result = await fetchFromDanmaku(
      site({ DanmakuApiBase: 'http://a.local:9321,http://b.local:9321' }),
      '/x'
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toEqual([{ host: 'http://a.local:9321', reason: 'HTTP 503' }]);
  });

  it('主源超时（AbortError）→ 换下一个，原因写成超时', async () => {
    mockFetch((url) => {
      if (url.startsWith('http://a.local:9321')) {
        return Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return { status: 200, body: 'ok' };
    });
    const result = await fetchFromDanmaku(
      site({ DanmakuApiBase: 'http://a.local:9321,http://b.local:9321' }),
      '/x',
      { timeoutMs: 30000 }
    );
    expect(result.ok).toBe(true);
    expect(result.attempts[0].reason).toBe('超时 30000ms');
  });

  it('主源返回 400 → **不**换源（请求本身有问题，换源只会掩盖真因）', async () => {
    const fetchFn = mockFetch(() => ({ status: 400, body: '{"error":"bad request"}' }));
    const result = await fetchFromDanmaku(
      site({ DanmakuApiBase: 'http://a.local:9321,http://b.local:9321' }),
      '/x'
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.attempts).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('所有候选都挂 → ok=false，attempts 覆盖每一跳，状态码不是 200', async () => {
    const fetchFn = mockFetch(() =>
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' })
    );
    const result = await fetchFromDanmaku(
      site({ DanmakuApiBase: 'http://a.local:9321,http://b.local:9321' }),
      '/x'
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.attempts).toHaveLength(3); // a、b、内置
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('3 个候选源全部失败'));
  });

  it('POST 会带上 JSON 体，GET 会带上 Accept', async () => {
    const seen: any[] = [];
    mockFetch((url, init) => {
      seen.push({ url, init });
      return { status: 200, body: '{}' };
    });

    await fetchFromDanmaku(site({ DanmakuSourceType: 'builtin' }), '/api/v2/match', {
      method: 'POST',
      body: { fileName: 'a.mp4' },
    });
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers['Content-Type']).toBe('application/json');
    expect(seen[0].init.body).toBe('{"fileName":"a.mp4"}');

    await fetchFromDanmaku(site({ DanmakuSourceType: 'builtin' }), '/api/v2/comment/1', {
      accept: 'application/xml, text/xml',
    });
    expect(seen[1].init.headers.Accept).toBe('application/xml, text/xml');
    expect(seen[1].init.body).toBeUndefined();
  });
});
