/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { getProxyToken } from '@/lib/emby-token';
import { hasFeaturePermission } from '@/lib/permissions';
import {
  buildWeightMap,
  getFanoutSettings,
  runSourceFanout,
  sortSitesByPriority,
} from '@/lib/search-fanout';
import {
  executeSavedSourceScript,
  listEnabledSourceScripts,
  normalizeScriptSearchResults,
  normalizeScriptSources,
} from '@/lib/source-script';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeSpecialSources = searchParams.get('special') === '1';
  const privateOnly = searchParams.get('privateOnly') === '1';

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  }

  const config = await getConfig();
  const apiSites = privateOnly
    ? []
    : await getAvailableApiSites(authInfo.username, includeSpecialSources);
  const [canAccessOpenList, canAccessEmby] = await Promise.all([
    hasFeaturePermission(authInfo.username, 'private_library'),
    hasFeaturePermission(authInfo.username, 'emby'),
  ]);

  // 创建权重映射表
  const weightMap = buildWeightMap(config.SourceConfig);

  // 按优先级排序：手动权重降序 → 原始顺序
  const sortedApiSites = sortSitesByPriority(apiSites, weightMap);

  // 调度参数：受控并发 + 够用即停（非流式路径同样受益：不再等最慢的源）
  const fanoutSettings = await getFanoutSettings();

  // 检查是否配置了 OpenList
  const hasOpenList = !!(
    canAccessOpenList &&
    config.OpenListConfig?.Enabled &&
    config.OpenListConfig?.URL &&
    config.OpenListConfig?.Username &&
    config.OpenListConfig?.Password
  );

  // 获取所有启用的 Emby 源
  const { embyManager } = await import('@/lib/emby-manager');
  const embySourcesMap = await embyManager.getAllClients();
  const embySources = canAccessEmby ? Array.from(embySourcesMap.values()) : [];

  console.log('[Search] Emby sources count:', embySources.length);
  console.log('[Search] Emby sources:', embySources.map(s => ({ key: s.config.key, name: s.config.name })));

  // 获取代理 token（用于图片代理）
  const proxyToken = await getProxyToken(request);

  // 为每个 Emby 源创建搜索 Promise（全部并发，无限制）
  const embyPromises = embySources.map(({ client, config: embyConfig }) =>
    Promise.race([
      (async () => {
        try {
          const searchResult = await client.getItems({
            searchTerm: query,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: 'Overview,ProductionYear',
            Limit: 50,
          });

          // 如果只有一个Emby源，保持旧格式（向后兼容）
          const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
          const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;

          return searchResult.Items.map((item) => ({
            id: item.Id,
            source: sourceValue,
            source_name: sourceName,
            weight: weightMap.get(sourceValue) ?? 0,
            title: item.Name,
            poster: client.getImageUrl(item.Id, 'Primary', undefined, client.isProxyEnabled() ? proxyToken || undefined : undefined),
            episodes: [],
            episodes_titles: [],
            year: item.ProductionYear?.toString() || '',
            desc: item.Overview || '',
            type_name: item.Type === 'Movie' ? '电影' : '电视剧',
            douban_id: 0,
          }));
        } catch (error) {
          console.error(`[Search] 搜索 ${embyConfig.name} 失败:`, error);
          return [];
        }
      })(),
      new Promise<any[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${embyConfig.name} timeout`)), 20000)
      ),
    ]).catch((error) => {
      console.error(`[Search] 搜索 ${embyConfig.name} 超时:`, error);
      return [];
    })
  );

  // 搜索 OpenList（如果配置了）- 异步带超时
  const openlistPromise = hasOpenList
    ? Promise.race([
        (async () => {
          try {
            const { getCachedMetaInfo, setCachedMetaInfo } = await import('@/lib/openlist-cache');
            const { getTMDBImageUrl } = await import('@/lib/tmdb.search');
            const { db } = await import('@/lib/db');

            let metaInfo = getCachedMetaInfo();

            if (!metaInfo) {
              const metainfoJson = await db.getGlobalValue('video.metainfo');
              if (metainfoJson) {
                metaInfo = JSON.parse(metainfoJson);
                if (metaInfo) {
                  setCachedMetaInfo(metaInfo);
                }
              }
            }

            if (metaInfo && metaInfo.folders) {
              return Object.entries(metaInfo.folders)
                .filter(([folderName, info]: [string, any]) => {
                  const matchFolder = folderName.toLowerCase().includes(query.toLowerCase());
                  const matchTitle = info.title.toLowerCase().includes(query.toLowerCase());
                  return matchFolder || matchTitle;
                })
                .map(([folderName, info]: [string, any]) => ({
                  id: folderName,
                  source: 'openlist',
                  source_name: '私人影库',
                  weight: weightMap.get('openlist') ?? 0,
                  title: info.title,
                  poster: getTMDBImageUrl(info.poster_path),
                  episodes: [],
                  episodes_titles: [],
                  year: info.release_date.split('-')[0] || '',
                  desc: info.overview,
                  type_name: info.media_type === 'movie' ? '电影' : '电视剧',
                  douban_id: 0,
                }));
            }
            return [];
          } catch (error) {
            console.error('[Search] 搜索 OpenList 失败:', error);
            return [];
          }
        })(),
        new Promise<any[]>((_, reject) =>
          setTimeout(() => reject(new Error('OpenList timeout')), 20000)
        ),
      ]).catch((error) => {
        console.error('[Search] 搜索 OpenList 超时:', error);
        return [];
      })
    : Promise.resolve([]);

  // API 源：受控并发 + 够用即停。命中源数/结果数达标即收手，
  // 不再被最慢的几个源拖住整条响应。
  const apiFanoutResults: any[] = [];
  const apiFanoutPromise = runSourceFanout({
    sites: sortedApiSites,
    query,
    concurrency: fanoutSettings.concurrency,
    minHitSources: fanoutSettings.minHitSources,
    minResults: fanoutSettings.minResults,
    onSourceDone: ({ results }) => {
      if (Array.isArray(results) && results.length > 0) {
        apiFanoutResults.push(...results);
      }
    },
  }).then((summary) => {
    console.log(
      `[Search] 扇出结束 「${query}」 检测=${summary.scannedSources} ` +
        `命中源=${summary.hitSources} 结果=${summary.totalResults} ` +
        `跳过=${summary.skippedSources} 早停=${summary.stopped} 耗时=${summary.elapsedMs}ms`
    );
    return apiFanoutResults;
  });

  const scriptSummaries = privateOnly ? [] : await listEnabledSourceScripts();
  const scriptPromises = scriptSummaries.map((script) =>
    Promise.race([
      (async () => {
        try {
          const sourcesExecution = await executeSavedSourceScript({
            key: script.key,
            hook: 'getSources',
            payload: {},
          });
          const sources = normalizeScriptSources(sourcesExecution.result);

          const searchResults = await Promise.all(
            sources.map(async (source) => {
              const execution = await executeSavedSourceScript({
                key: script.key,
                hook: 'search',
                payload: {
                  keyword: query,
                  page: 1,
                  sourceId: source.id,
                },
              });

              return normalizeScriptSearchResults({
                scriptKey: script.key,
                scriptName: script.name,
                sourceId: source.id,
                sourceName: source.name,
                result: execution.result,
              });
            })
          );

          return searchResults.flat();
        } catch (error) {
          console.error(`[Search] 搜索脚本 ${script.name} 失败:`, error);
          return [];
        }
      })(),
      new Promise<any[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${script.name} timeout`)), 20000)
      ),
    ]).catch((error) => {
      console.error(`[Search] 搜索脚本 ${script.name} 超时:`, error);
      return [];
    })
  );

  try {
    const allResults = await Promise.all([
      openlistPromise,
      ...embyPromises,
      apiFanoutPromise,
      ...scriptPromises,
    ]);

    // 分离结果：第一个是 openlist，接着是 emby 结果，然后是 api 结果（已拍平），最后是脚本结果
    // 添加安全检查，确保即使某个结果处理出错也不影响其他结果
    const apiIndex = 1 + embyPromises.length;
    const openlistResults = Array.isArray(allResults[0]) ? allResults[0] : [];
    const embyResultsArray = allResults.slice(1, apiIndex);
    const apiResultsFlat = Array.isArray(allResults[apiIndex]) ? allResults[apiIndex] : [];
    const scriptResults = allResults.slice(apiIndex + 1);

    // 合并所有 Emby 结果，添加安全检查
    const embyResults = embyResultsArray.filter(Array.isArray).flat();
    const scriptResultsFlat = scriptResults.filter(Array.isArray).flat();

    let flattenedResults = [...openlistResults, ...embyResults, ...apiResultsFlat, ...scriptResultsFlat];

    flattenedResults = flattenedResults.map((result) => ({
      ...result,
      weight: result.weight ?? (weightMap.get(result.source) ?? 0),
    }));

    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }

    // 按权重降序排序
    flattenedResults.sort((a, b) => {
      const weightA = a.weight ?? 0;
      const weightB = b.weight ?? 0;
      return weightB - weightA;
    });

    const cacheTime = await getCacheTime();

    if (flattenedResults.length === 0) {
      // no cache if empty
      return NextResponse.json({ results: [] }, { status: 200 });
    }

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  } catch (error) {
    console.error('[Search] 搜索结果处理失败:', error);
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
