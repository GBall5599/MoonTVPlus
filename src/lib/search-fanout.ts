/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import type { ApiSite } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import type { SearchResult } from '@/lib/types';

/**
 * 搜索源扇出调度：**优先级排序 + 受控并发 + 够用即停**。
 *
 * 为什么需要它：
 *   改造前 /api/search(ws) 把全部启用源（本机 155 个）在 t=0 一次性并发打出去，
 *   并且只有等全部返回才推 complete。于是：
 *     - 用户等待时间 = 最慢那个源（实测 34~67s）；
 *     - "优先级"没有意义 —— 所有源同时出发，第 8 个命中何时到达和排序无关；
 *     - 155 条连接互相抢出口带宽/套接字，把本来 1.4s 的源也拖慢。
 *
 * 改造后：
 *   1. 按优先级顺序**逐个补位**派发，同时在途的源不超过 concurrency 个；
 *   2. 每完成一个源就回调一次（流式路由立刻推给客户端）；
 *   3. 一旦"命中的源数 >= minHitSources"__或__"结果数 >= minResults"，
 *      立刻中止在途请求、不再派发后面的源，标记 stopped。
 *
 * 于是：用户等待时间 ≈ 前 concurrency 个源里第 8 个命中返回的时间（≈ 2~4s），
 * 而不是全部 155 个跑完（≈ 40s）。剩下的慢源被直接掐掉。
 *
 * ⚠️ minResults 默认是 **0（= 不看这一项）**，只有 minHitSources 生效。
 *    原因（实测）：有源对查询词做很松的子串匹配 —— 搜「不存在的片子zzz」
 *    这种乱码词，155 个源里只有 1 个返回结果，而它一个人就返回 161~232 条。
 *    只要挂上"结果条数"阈值，就会被这一个噪声源独自顶满，搜索在第一批就收手，
 *    真正有货的源根本没轮到被检测。**按"命中源数"收手才是想要的语义。**
 */

export interface FanoutSourceOutcome {
  /** 源 key */
  key: string;
  /** 源名称 */
  name: string;
  /** 该源返回的结果（未做黄反/权重装饰，由调用方处理） */
  results: SearchResult[];
  /** 出错信息（超时/网络错误），成功时为 undefined */
  error?: string;
  /** 该源耗时（毫秒） */
  elapsedMs: number;
}

export interface FanoutSummary {
  /** 是否因为"够用"而提前收手 */
  stopped: boolean;
  /** 实际检测过的源数（含 0 结果和失败的） */
  scannedSources: number;
  /** 返回了至少一条结果的源数（"可用的源"） */
  hitSources: number;
  /** 累计结果条数 */
  totalResults: number;
  /** 因提前收手而没检测的源数 */
  skippedSources: number;
  /** 整段扇出的墙钟耗时 */
  elapsedMs: number;
}

export interface FanoutOptions {
  /** 已按优先级排好序的源 */
  sites: ApiSite[];
  query: string;
  /** 同时在途的源数上限；<= 0 表示不限制 */
  concurrency: number;
  /** 命中多少个源就收手；<= 0 表示不看这个条件 */
  minHitSources: number;
  /** 攒够多少条结果就收手；<= 0 表示不看这个条件 */
  minResults: number;
  /** 每个源检测完就回调一次（含 0 结果与失败） */
  onSourceDone?: (outcome: FanoutSourceOutcome) => void;
  /** 外部取消信号（客户端断开等） */
  signal?: AbortSignal;
}

/** 单源外层超时（毫秒）：与改造前保持一致，避免悄悄改变慢源的判定 */
const PER_SOURCE_TIMEOUT_MS = 20000;

/**
 * 是否已经"够用"。
 * 两个阈值是**或**关系：任何一个满足就收手。
 */
export function isEnough(
  hitSources: number,
  totalResults: number,
  minHitSources: number,
  minResults: number
): boolean {
  if (minHitSources > 0 && hitSources >= minHitSources) return true;
  if (minResults > 0 && totalResults >= minResults) return true;
  return false;
}

/**
 * 按优先级给源排序。
 *
 * 排序键（依次比较）：
 *   1. 手动权重降序 —— 后台「权重管理」里的 weight，0 表示"不表态"
 *   2. 原始顺序升序 —— SourceConfig 数组顺序（也就是权重管理弹窗里拖出来的顺序）
 *
 * weight 是唯一的显式优先级开关：谁大谁先被检测。全为 0 时退化成数组顺序，
 * 与改造前的行为一致，不会因为没配权重就把顺序搞乱。
 */
export function sortSitesByPriority(
  sites: ApiSite[],
  weights: Map<string, number>
): ApiSite[] {
  return sites
    .map((site, index) => ({ site, index }))
    .sort((a, b) => {
      const wa = weights.get(a.site.key) ?? 0;
      const wb = weights.get(b.site.key) ?? 0;
      if (wa !== wb) return wb - wa;
      return a.index - b.index;
    })
    .map((entry) => entry.site);
}

/** 从站点配置里把权重表取出来（后台权重管理的唯一数据源） */
export function buildWeightMap(
  sourceConfig: { key: string; weight?: number }[]
): Map<string, number> {
  const map = new Map<string, number>();
  sourceConfig.forEach((source) => {
    map.set(source.key, source.weight ?? 0);
  });
  return map;
}

/**
 * 读取"够用即停"相关配置并给出安全默认值。
 * 配置缺失/非法时一律回退到默认值，保证老配置升级后行为可预期。
 */
export async function getFanoutSettings(): Promise<{
  concurrency: number;
  minHitSources: number;
  minResults: number;
  earlyStop: boolean;
}> {
  let siteConfig: any = {};
  try {
    // 动态导入：本模块的核心逻辑（排序/并发/早停）不该被配置层拖下水，
    // 也让单测可以直接跑调度算法而不必拉起整个 DB 层。
    const { getConfig } = await import('@/lib/config');
    const config = await getConfig();
    siteConfig = config?.SiteConfig || {};
  } catch (error) {
    console.warn('[Search Fanout] 读取配置失败，使用默认调度参数:', error);
  }

  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
  };

  const earlyStop = siteConfig.SearchEarlyStop !== false; // 默认开
  const minHitSources = earlyStop
    ? num(siteConfig.SearchEarlyStopMinSources, 8, 1, 200)
    : 0;
  // 0 是合法值，含义是"只看命中源数，不看结果条数"（默认就是这个）
  const minResults = earlyStop
    ? num(siteConfig.SearchEarlyStopMinResults, 0, 0, 10000)
    : 0;

  return {
    earlyStop,
    minHitSources,
    minResults,
    concurrency: num(siteConfig.SearchConcurrency, 20, 1, 500),
  };
}

/**
 * 执行一次源扇出。返回汇总信息；逐源结果通过 onSourceDone 回调。
 *
 * 不抛异常：单个源失败/超时只记为该源 0 结果，不影响其它源。
 */
export async function runSourceFanout(
  options: FanoutOptions
): Promise<FanoutSummary> {
  const {
    sites,
    query,
    concurrency,
    minHitSources,
    minResults,
    onSourceDone,
    signal,
  } = options;

  const startedAt = Date.now();
  const inFlight = new Set<AbortController>();
  let stopped = false;
  let scannedSources = 0;
  let hitSources = 0;
  let totalResults = 0;
  let nextIndex = 0;

  const abortAll = () => {
    inFlight.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* 已 abort 过，忽略 */
      }
    });
    inFlight.clear();
  };

  /** 检测单个源，返回是否命中了结果 */
  const scanOne = async (site: ApiSite): Promise<void> => {
    const controller = new AbortController();
    inFlight.add(controller);

    const t0 = Date.now();
    let results: SearchResult[] = [];
    let error: string | undefined;

    const outerTimeout = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, PER_SOURCE_TIMEOUT_MS);

    try {
      const raw = await searchFromApi(site, query, controller.signal);
      results = Array.isArray(raw) ? raw : [];
    } catch (err: any) {
      error = err instanceof Error ? err.message : '搜索失败';
    } finally {
      clearTimeout(outerTimeout);
      inFlight.delete(controller);
    }

    const elapsedMs = Date.now() - t0;

    // 早停后返回的空结果是"我们主动放弃"，不计入统计也不回调
    if (stopped && results.length === 0 && error === undefined) {
      return;
    }

    scannedSources++;
    if (results.length > 0) {
      hitSources++;
      totalResults += results.length;
    }

    try {
      onSourceDone?.({ key: site.key, name: site.name, results, error, elapsedMs });
    } catch (cbError) {
      console.warn('[Search Fanout] onSourceDone 回调异常:', cbError);
    }
  };

  const limit = concurrency > 0 ? concurrency : sites.length || 1;

  // 受控并发：每有一个槽位空出来就补下一个（按优先级顺序），
  // 一旦够用就停止补位。
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, sites.length); w++) {
    workers.push(
      (async () => {
        while (!stopped && !signal?.aborted) {
          const index = nextIndex++;
          if (index >= sites.length) return;
          await scanOne(sites[index]);
          if (!stopped) {
            stopped = isEnough(hitSources, totalResults, minHitSources, minResults);
            if (stopped) abortAll();
          }
        }
      })()
    );
  }

  await Promise.allSettled(workers);
  if (!stopped && signal?.aborted) {
    // 客户端断开：同样掐掉在途请求，但不标 stopped（不是"够用"）
    abortAll();
  }

  return {
    stopped,
    scannedSources,
    hitSources,
    totalResults,
    skippedSources: Math.max(sites.length - scannedSources, 0),
    elapsedMs: Date.now() - startedAt,
  };
}
