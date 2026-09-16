/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import {
  buildWeightMap,
  getFanoutSettings,
  runSourceFanout,
  sortSitesByPriority,
} from '@/lib/search-fanout';
import { hasFeaturePermission } from '@/lib/permissions';
import { yellowWords } from '@/lib/yellow';
import { getProxyToken } from '@/lib/emby-token';
import {
  executeSavedSourceScript,
  listEnabledSourceScripts,
  normalizeScriptSearchResults,
  normalizeScriptSources,
} from '@/lib/source-script';

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
    return new Response(
      JSON.stringify({ error: '搜索关键词不能为空' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
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

  // 按优先级排序：手动权重降序 → 原始顺序。权重就是"先检测谁"的显式开关。
  const sortedApiSites = sortSitesByPriority(apiSites, weightMap);

  // 调度参数：受控并发 + 够用即停
  const fanoutSettings = await getFanoutSettings();
  console.log(
    `[Search WS] 调度参数 并发=${fanoutSettings.concurrency} ` +
      `早停=${fanoutSettings.earlyStop} 命中源≥${fanoutSettings.minHitSources} ` +
      `或结果≥${fanoutSettings.minResults}｜源数=${sortedApiSites.length}`
  );

  // 检查是否配置了 OpenList
  const hasOpenList = !!(
    canAccessOpenList &&
    config.OpenListConfig?.Enabled &&
    config.OpenListConfig?.URL &&
    config.OpenListConfig?.Username &&
    config.OpenListConfig?.Password
  );

  // 检查是否配置了 Emby（支持多源）
  const hasEmby = !!(
    canAccessEmby &&
    config.EmbyConfig?.Sources &&
    config.EmbyConfig.Sources.length > 0 &&
    config.EmbyConfig.Sources.some(s => s.enabled && s.ServerURL)
  );
  const enabledScripts = privateOnly ? [] : await listEnabledSourceScripts();

  // 共享状态
  let streamClosed = false;
  // 客户端断开时用它掐掉在途的源请求
  const clientAbort = new AbortController();

  // 创建可读流
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // 辅助函数：安全地向控制器写入数据
      const safeEnqueue = (data: Uint8Array) => {
        try {
          if (streamClosed || (!controller.desiredSize && controller.desiredSize !== 0)) {
            // 流已标记为关闭或控制器已关闭
            return false;
          }
          controller.enqueue(data);
          return true;
        } catch (error) {
          // 控制器已关闭或出现其他错误
          console.warn('Failed to enqueue data:', error);
          streamClosed = true;
          return false;
        }
      };

      // 获取 Emby 源数量
      let embySourcesCount = 0;
      if (hasEmby) {
        try {
          const { embyManager } = await import('@/lib/emby-manager');
          const embySourcesMap = await embyManager.getAllClients();
          embySourcesCount = embySourcesMap.size;
        } catch (error) {
          console.error('[Search WS] 获取 Emby 源数量失败:', error);
        }
      }

      const totalSourceCount = sortedApiSites.length + (hasOpenList ? 1 : 0) + embySourcesCount + enabledScripts.length;

      // 发送开始事件
      const startEvent = `data: ${JSON.stringify({
        type: 'start',
        query,
        totalSources: totalSourceCount,
        timestamp: Date.now()
      })}\n\n`;

      if (!safeEnqueue(encoder.encode(startEvent))) {
        return; // 连接已关闭，提前退出
      }

      // 记录已完成的源数量
      let completedSources = 0;
      const allResults: any[] = [];

      /**
       * 收尾：推送 complete 并关闭流。
       * reason: 'all' = 所有源都检测完了；'enough' = 够用即停，后面的源没检测。
       */
      const finish = (
        reason: 'all' | 'enough',
        extra?: {
          scannedSources?: number;
          skippedSources?: number;
          hitSources?: number;
          elapsedMs?: number;
        }
      ) => {
        if (streamClosed) return;
        const completeEvent = `data: ${JSON.stringify({
          type: 'complete',
          totalResults: allResults.length,
          completedSources,
          totalSources: totalSourceCount,
          stopped: reason === 'enough',
          stopReason: reason,
          ...(extra || {}),
          timestamp: Date.now()
        })}\n\n`;

        if (safeEnqueue(encoder.encode(completeEvent))) {
          streamClosed = true;
          try {
            controller.close();
          } catch (error) {
            console.warn('Failed to close controller:', error);
          }
        }
      };

      const maybeComplete = () => {
        if (completedSources !== totalSourceCount || streamClosed) return;
        finish('all');
      };

      if (totalSourceCount === 0) {
        maybeComplete();
        return;
      }

      // 搜索 Emby（如果配置了）- 异步带超时，支持多源
      if (hasEmby) {
        (async () => {
          let embyCompletedCount = 0;
          try {
            const { embyManager } = await import('@/lib/emby-manager');
            const embySourcesMap = await embyManager.getAllClients();
            const embySources = Array.from(embySourcesMap.values());

            // 获取代理 token（用于图片代理）
            const proxyToken = await getProxyToken(request);

            // 为每个 Emby 源并发搜索，并单独发送结果
            const embySearchPromises = embySources.map(async ({ client, config: embyConfig }) => {
              try {
                const searchResult = await client.getItems({
                  searchTerm: query,
                  IncludeItemTypes: 'Movie,Series',
                  Recursive: true,
                  Fields: 'Overview,ProductionYear',
                  Limit: 50,
                });

                const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
                const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;

                // 添加安全检查，确保 Items 存在且是数组
                const items = Array.isArray(searchResult?.Items) ? searchResult.Items : [];
                const results = items.map((item) => ({
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

                // 单独发送每个源的结果
                embyCompletedCount++;
                completedSources++;
                if (!streamClosed) {
                  const sourceEvent = `data: ${JSON.stringify({
                    type: 'source_result',
                    source: sourceValue,
                    sourceName: sourceName,
                    results: results,
                    timestamp: Date.now()
                  })}\n\n`;
                  if (safeEnqueue(encoder.encode(sourceEvent))) {
                    if (results.length > 0) {
                      allResults.push(...results);
                    }
                  } else {
                    streamClosed = true;
                  }
                }
                maybeComplete();

                return results;
              } catch (error) {
                console.error(`[Search WS] 搜索 ${embyConfig.name} 失败:`, error);
                embyCompletedCount++;
                completedSources++;
                // 发送空结果
                if (!streamClosed) {
                  const sourceValue = embySources.length === 1 ? 'emby' : `emby_${embyConfig.key}`;
                  const sourceName = embySources.length === 1 ? 'Emby' : embyConfig.name;
                  const sourceEvent = `data: ${JSON.stringify({
                    type: 'source_result',
                    source: sourceValue,
                    sourceName: sourceName,
                    results: [],
                    timestamp: Date.now()
                  })}\n\n`;
                  safeEnqueue(encoder.encode(sourceEvent));
                }
                maybeComplete();
                return [];
              }
            });

            await Promise.all(embySearchPromises);
          } catch (error) {
            console.error('[Search WS] 搜索 Emby 整体失败:', error);
            // 如果整个 emby 搜索失败，需要补齐未完成的源
            const remainingSources = embySourcesCount - embyCompletedCount;
            for (let i = 0; i < remainingSources; i++) {
              completedSources++;
              if (!streamClosed) {
                const sourceEvent = `data: ${JSON.stringify({
                  type: 'source_result',
                  source: 'emby',
                  sourceName: 'Emby',
                  results: [],
                  timestamp: Date.now()
                })}\n\n`;
                safeEnqueue(encoder.encode(sourceEvent));
              }
              maybeComplete();
            }
          }
        })();
      }

      // 搜索 OpenList（如果配置了）- 异步带超时
      if (hasOpenList) {
        Promise.race([
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
                  .filter(([key, info]: [string, any]) => {
                    const matchFolder = info.folderName.toLowerCase().includes(query.toLowerCase());
                    const matchTitle = info.title.toLowerCase().includes(query.toLowerCase());
                    return matchFolder || matchTitle;
                  })
                  .map(([key, info]: [string, any]) => ({
                    id: key,
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
              console.error('[Search WS] 搜索 OpenList 失败:', error);
              return [];
            }
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OpenList timeout')), 20000)
          ),
        ])
          .then((openlistResults: any) => {
            completedSources++;
            if (!streamClosed) {
              // 添加安全检查，确保结果是数组
              const safeResults = Array.isArray(openlistResults) ? openlistResults : [];
              const sourceEvent = `data: ${JSON.stringify({
                type: 'source_result',
                source: 'openlist',
                sourceName: '私人影库',
                results: safeResults,
                timestamp: Date.now()
              })}\n\n`;
              if (!safeEnqueue(encoder.encode(sourceEvent))) {
                streamClosed = true;
                return;
              }
              if (safeResults.length > 0) {
                allResults.push(...safeResults);
              }
            }
            maybeComplete();
          })
          .catch((error) => {
            console.error('[Search WS] 搜索 OpenList 超时:', error);
            completedSources++;
            if (!streamClosed) {
              const sourceEvent = `data: ${JSON.stringify({
                type: 'source_result',
                source: 'openlist',
                sourceName: '私人影库',
                results: [],
                timestamp: Date.now()
              })}\n\n`;
              safeEnqueue(encoder.encode(sourceEvent));
            }
            maybeComplete();
          });
      }

      /**
       * API 源：受控并发 + 够用即停。
       * 每检测完一个源就推一条 source_result；一旦命中源数/结果数达标，
       * runSourceFanout 会立刻中止在途请求并停止派发后面的源。
       */
      const apiFanoutPromise = runSourceFanout({
        sites: sortedApiSites,
        query,
        concurrency: fanoutSettings.concurrency,
        minHitSources: fanoutSettings.minHitSources,
        minResults: fanoutSettings.minResults,
        signal: clientAbort.signal,
        onSourceDone: ({ key, name, results, error }) => {
          // 添加安全检查，确保结果是数组
          const safeResults = Array.isArray(results) ? results : [];

          // 过滤黄色内容
          let filteredResults = safeResults;
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = safeResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }

          filteredResults = filteredResults.map((result) => ({
            ...result,
            weight: result.weight ?? (weightMap.get(result.source) ?? 0),
          }));

          completedSources++;

          if (streamClosed) return;

          const payload =
            error !== undefined && filteredResults.length === 0
              ? {
                  type: 'source_error',
                  source: key,
                  sourceName: name,
                  error,
                  timestamp: Date.now(),
                }
              : {
                  type: 'source_result',
                  source: key,
                  sourceName: name,
                  results: filteredResults,
                  timestamp: Date.now(),
                };

          if (!safeEnqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))) {
            streamClosed = true;
            clientAbort.abort();
            return;
          }

          if (filteredResults.length > 0) {
            allResults.push(...filteredResults);
          }
        },
      }).then((summary) => {
        try {
          console.log(
            `[Search WS] 扇出结束 「${query}」 检测=${summary.scannedSources} ` +
              `命中源=${summary.hitSources} 结果=${summary.totalResults} ` +
              `跳过=${summary.skippedSources} 早停=${summary.stopped} 耗时=${summary.elapsedMs}ms`
          );
        } catch {
          /* 日志失败不影响结果 */
        }
        return summary;
      });

      const scriptPromises = enabledScripts.map(async (script) => {
        try {
          const sourcesExecution = await Promise.race([
            executeSavedSourceScript({
              key: script.key,
              hook: 'getSources',
              payload: {},
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`${script.name} timeout`)), 20000)
            ),
          ]);

          const sources = normalizeScriptSources((sourcesExecution as any).result);
          const sourceResults = await Promise.all(
            sources.map(async (source) => {
              const execution = await Promise.race([
                executeSavedSourceScript({
                  key: script.key,
                  hook: 'search',
                  payload: {
                    keyword: query,
                    page: 1,
                    sourceId: source.id,
                  },
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`${script.name}/${source.name} timeout`)), 20000)
                ),
              ]);

              return normalizeScriptSearchResults({
                scriptKey: script.key,
                scriptName: script.name,
                sourceId: source.id,
                sourceName: source.name,
                result: (execution as any).result,
              });
            })
          );

          let filteredResults = sourceResults.flat();
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = filteredResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }

          completedSources++;

          if (!streamClosed) {
            const sourceEvent = `data: ${JSON.stringify({
              type: 'source_result',
              source: `script:${script.key}`,
              sourceName: script.name,
              results: filteredResults,
              timestamp: Date.now()
            })}\n\n`;

            if (!safeEnqueue(encoder.encode(sourceEvent))) {
              streamClosed = true;
              return;
            }
          }

          if (filteredResults.length > 0) {
            allResults.push(...filteredResults);
          }
        } catch (error) {
          console.warn(`搜索脚本失败 ${script.name}:`, error);

          completedSources++;

          if (!streamClosed) {
            const errorEvent = `data: ${JSON.stringify({
              type: 'source_error',
              source: `script:${script.key}`,
              sourceName: script.name,
              error: error instanceof Error ? error.message : '搜索失败',
              timestamp: Date.now()
            })}\n\n`;

            if (!safeEnqueue(encoder.encode(errorEvent))) {
              streamClosed = true;
              return;
            }
          }
        }

        maybeComplete();
      });

      // 等 API 源扇出结束（够用即停时它会立刻收手）＋ 脚本源结束
      const [apiSummary] = await Promise.all([
        apiFanoutPromise,
        Promise.allSettled(scriptPromises),
      ]);

      if (apiSummary.stopped) {
        // 够用即停：不再等后面的源，直接收尾
        finish('enough', {
          scannedSources: apiSummary.scannedSources,
          skippedSources: apiSummary.skippedSources,
          hitSources: apiSummary.hitSources,
          elapsedMs: apiSummary.elapsedMs,
        });
      } else {
        maybeComplete();
      }
    },

    cancel() {
      // 客户端断开连接时，标记流已关闭并掐掉在途的源请求
      streamClosed = true;
      clientAbort.abort();
      console.log('Client disconnected, cancelling search stream');
    },
  });

  // 返回流式响应
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
