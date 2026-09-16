// 弹幕搜索 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { danmakuFailureMessage, fetchFromDanmaku } from '@/lib/danmaku/proxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const keyword = request.nextUrl.searchParams.get('keyword');

    if (!keyword) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '缺少关键词参数',
          animes: [],
        },
        { status: 400 }
      );
    }

    // 从数据库读取弹幕配置，交给带备用源降级的代理（见 lib/danmaku/proxy.ts）
    const config = await getConfig();
    const result = await fetchFromDanmaku(
      config.SiteConfig,
      `/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`,
      { timeoutMs: 12000, label: '搜索' }
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: danmakuFailureMessage(result),
          animes: [],
        },
        { status: 502 }
      );
    }

    try {
      return NextResponse.json(JSON.parse(result.text));
    } catch {
      console.error(`[弹幕] 搜索：${result.sourceOrigin} 返回的不是 JSON`);
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '弹幕服务返回了非 JSON 内容',
          animes: [],
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('弹幕搜索代理错误:', error);
    return NextResponse.json(
      {
        errorCode: -1,
        success: false,
        errorMessage: error instanceof Error ? error.message : '搜索失败',
        animes: [],
      },
      { status: 500 }
    );
  }
}
