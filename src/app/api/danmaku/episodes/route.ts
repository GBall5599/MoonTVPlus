// 获取剧集列表 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { danmakuFailureMessage, fetchFromDanmaku } from '@/lib/danmaku/proxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const animeId = request.nextUrl.searchParams.get('animeId');

    if (!animeId) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '缺少动漫ID参数',
          bangumi: {
            bangumiId: '',
            animeTitle: '',
            episodes: [],
          },
        },
        { status: 400 }
      );
    }

    const config = await getConfig();
    const result = await fetchFromDanmaku(
      config.SiteConfig,
      `/api/v2/bangumi/${encodeURIComponent(animeId)}`,
      { timeoutMs: 12000, label: '剧集' }
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: danmakuFailureMessage(result),
          bangumi: {
            bangumiId: '',
            animeTitle: '',
            episodes: [],
          },
        },
        { status: 502 }
      );
    }

    try {
      return NextResponse.json(JSON.parse(result.text));
    } catch {
      console.error(`[弹幕] 剧集：${result.sourceOrigin} 返回的不是 JSON`);
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '弹幕服务返回了非 JSON 内容',
          bangumi: {
            bangumiId: '',
            animeTitle: '',
            episodes: [],
          },
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('获取剧集列表代理错误:', error);
    return NextResponse.json(
      {
        errorCode: -1,
        success: false,
        errorMessage:
          error instanceof Error ? error.message : '获取剧集列表失败',
        bangumi: {
          bangumiId: '',
          animeTitle: '',
          episodes: [],
        },
      },
      { status: 500 }
    );
  }
}
