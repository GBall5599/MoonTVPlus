// 自动匹配 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { danmakuFailureMessage, fetchFromDanmaku } from '@/lib/danmaku/proxy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileName } = body;

    if (!fileName) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '缺少文件名参数',
          isMatched: false,
          matches: [],
        },
        { status: 400 }
      );
    }

    const config = await getConfig();
    const result = await fetchFromDanmaku(config.SiteConfig, '/api/v2/match', {
      method: 'POST',
      body: { fileName },
      timeoutMs: 12000,
      label: '匹配',
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: danmakuFailureMessage(result),
          isMatched: false,
          matches: [],
        },
        { status: 502 }
      );
    }

    try {
      return NextResponse.json(JSON.parse(result.text));
    } catch {
      console.error(`[弹幕] 匹配：${result.sourceOrigin} 返回的不是 JSON`);
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '弹幕服务返回了非 JSON 内容',
          isMatched: false,
          matches: [],
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('自动匹配代理错误:', error);
    return NextResponse.json(
      {
        errorCode: -1,
        success: false,
        errorMessage: error instanceof Error ? error.message : '匹配失败',
        isMatched: false,
        matches: [],
      },
      { status: 500 }
    );
  }
}
