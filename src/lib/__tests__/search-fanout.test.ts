/**
 * 搜索源扇出的行为契约测试（优先级排序 / 受控并发 / 够用即停）。
 *
 * 这是本次改造的核心逻辑，用真实单测锁住语义，避免只能靠"部署上去看快不快"来验证。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/lib/downstream', () => ({
  searchFromApi: jest.fn(),
}));

import { searchFromApi } from '@/lib/downstream';
import {
  buildWeightMap,
  isEnough,
  runSourceFanout,
  sortSitesByPriority,
} from '@/lib/search-fanout';

const mockedSearch = searchFromApi as unknown as jest.Mock;

const site = (key: string) => ({ key, name: `源-${key}`, api: 'https://example.invalid/api' });

/** 让一个源在 delayMs 后返回 results，并记录当时的"在途数量"峰值 */
function delayedResults(delayMs: number, count: number) {
  return () => new Promise((resolve) => setTimeout(() => resolve(
    Array.from({ length: count }, (_, i) => ({
      id: `${i}`,
      title: 't',
      poster: '',
      episodes: ['e'],
      episodes_titles: ['1'],
      source: 'x',
      source_name: 'x',
      year: '2024',
      desc: '',
      type_name: '剧集',
      douban_id: 0,
    }))
  ), delayMs));
}

describe('isEnough —— 两个阈值是"或"关系', () => {
  it('命中源数达标即够用', () => {
    expect(isEnough(8, 1, 8, 60)).toBe(true);
  });

  it('结果条数达标即够用', () => {
    expect(isEnough(1, 60, 8, 60)).toBe(true);
  });

  it('都没达标就不够用', () => {
    expect(isEnough(7, 59, 8, 60)).toBe(false);
  });

  it('阈值 <= 0 表示不看该条件', () => {
    expect(isEnough(0, 0, 0, 0)).toBe(false);
    expect(isEnough(9999, 9999, 0, 0)).toBe(false);
    expect(isEnough(1, 0, 0, 10)).toBe(false);
    expect(isEnough(0, 10, 5, 0)).toBe(false);
  });
});

describe('sortSitesByPriority —— 权重降序、同权重保持原顺序', () => {
  it('权重大的排前面', () => {
    const sites = [site('a'), site('b'), site('c')];
    const weights = buildWeightMap([
      { key: 'a', weight: 0 },
      { key: 'b', weight: 60 },
      { key: 'c', weight: 20 },
    ]);
    expect(sortSitesByPriority(sites, weights).map((s) => s.key)).toEqual(['b', 'c', 'a']);
  });

  it('权重全为 0 时退化成原顺序（不因没配权重就把顺序打乱）', () => {
    const sites = [site('a'), site('b'), site('c')];
    const weights = buildWeightMap(sites.map((s) => ({ key: s.key, weight: 0 })));
    expect(sortSitesByPriority(sites, weights).map((s) => s.key)).toEqual(['a', 'b', 'c']);
  });

  it('缺失的源按权重 0 处理，不丢源', () => {
    const sites = [site('a'), site('b')];
    const weights = buildWeightMap([{ key: 'b', weight: 10 }]);
    const sorted = sortSitesByPriority(sites, weights);
    expect(sorted.map((s) => s.key)).toEqual(['b', 'a']);
    expect(sorted).toHaveLength(2);
  });
});

describe('runSourceFanout —— 够用即停', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
  });

  it('命中源数达标就收手，不再检测后面的源', async () => {
    // 所有源都立即命中 2 条结果；阈值 = 3 个源
    mockedSearch.mockImplementation(async () => delayedResults(0, 2)());

    const sites = Array.from({ length: 20 }, (_, i) => site(`s${i}`));
    const seen: string[] = [];

    const summary = await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 2, // 故意限制并发，让早停能真正省下后面的活
      minHitSources: 3,
      minResults: 0,
      onSourceDone: (o) => seen.push(o.key),
    });

    expect(summary.stopped).toBe(true);
    expect(summary.hitSources).toBeGreaterThanOrEqual(3);
    // 关键断言：没有把 20 个源全跑一遍
    expect(summary.scannedSources).toBeLessThan(sites.length);
    expect(summary.skippedSources).toBe(sites.length - summary.scannedSources);
    expect(seen.length).toBe(summary.scannedSources);
  });

  it('结果条数达标也能触发早停', async () => {
    mockedSearch.mockImplementation(async () => delayedResults(0, 30)());

    const sites = Array.from({ length: 20 }, (_, i) => site(`s${i}`));
    const summary = await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 2,
      minHitSources: 0, // 只看条数
      minResults: 60,
    });

    expect(summary.stopped).toBe(true);
    expect(summary.totalResults).toBeGreaterThanOrEqual(60);
    expect(summary.scannedSources).toBeLessThan(sites.length);
  });

  it('阈值都关掉时会把所有源检测完', async () => {
    mockedSearch.mockImplementation(async () => delayedResults(0, 1)());

    const sites = Array.from({ length: 12 }, (_, i) => site(`s${i}`));
    const summary = await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 4,
      minHitSources: 0,
      minResults: 0,
    });

    expect(summary.stopped).toBe(false);
    expect(summary.scannedSources).toBe(12);
    expect(summary.skippedSources).toBe(0);
  });

  it('全都没结果时不早停，且 hitSources 为 0', async () => {
    mockedSearch.mockImplementation(async () => []);

    const sites = Array.from({ length: 10 }, (_, i) => site(`s${i}`));
    const summary = await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 3,
      minHitSources: 3,
      minResults: 60,
    });

    expect(summary.stopped).toBe(false);
    expect(summary.hitSources).toBe(0);
    expect(summary.scannedSources).toBe(10);
  });
});

describe('runSourceFanout —— 受控并发', () => {
  beforeEach(() => {
    mockedSearch.mockReset();
  });

  it('同时在途的源数不超过 concurrency', async () => {
    let inFlight = 0;
    let peak = 0;

    mockedSearch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const value = await delayedResults(10, 1)();
      inFlight--;
      return value;
    });

    const sites = Array.from({ length: 30 }, (_, i) => site(`s${i}`));
    await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 5,
      minHitSources: 0,
      minResults: 0,
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // 确实是并发而不是串行
  });

  it('按优先级顺序派发：高权重源先被检测', async () => {
    const order: string[] = [];
    mockedSearch.mockImplementation(async (s: any) => {
      order.push(s.key);
      return delayedResults(0, 0)();
    });

    const sites = Array.from({ length: 6 }, (_, i) => site(`s${i}`));
    const weights = buildWeightMap([
      { key: 's0', weight: 0 },
      { key: 's1', weight: 10 },
      { key: 's2', weight: 20 },
      { key: 's3', weight: 30 },
      { key: 's4', weight: 40 },
      { key: 's5', weight: 50 },
    ]);

    await runSourceFanout({
      sites: sortSitesByPriority(sites, weights),
      query: 'q',
      concurrency: 1, // 串行才能确定性观察派发顺序
      minHitSources: 0,
      minResults: 0,
    });

    expect(order).toEqual(['s5', 's4', 's3', 's2', 's1', 's0']);
  });

  it('单个源抛异常只算该源 0 结果，不影响其它源', async () => {
    mockedSearch.mockImplementation(async (s: any) => {
      if (s.key === 's1') throw new Error('boom');
      return delayedResults(0, 1)();
    });

    const sites = Array.from({ length: 4 }, (_, i) => site(`s${i}`));
    const errored: string[] = [];
    const summary = await runSourceFanout({
      sites,
      query: 'q',
      concurrency: 2,
      minHitSources: 0,
      minResults: 0,
      onSourceDone: (o) => {
        if (o.error) errored.push(o.key);
      },
    });

    expect(summary.scannedSources).toBe(4);
    expect(summary.hitSources).toBe(3);
    expect(errored).toEqual(['s1']);
  });
});
