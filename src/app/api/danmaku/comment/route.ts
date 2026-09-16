// 获取弹幕 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { danmakuFailureMessage, fetchFromDanmaku } from '@/lib/danmaku/proxy';

export const runtime = 'nodejs';

// 解析弹幕 XML 为 JSON
function parseXmlDanmaku(xmlText: string): Array<{ p: string; m: string; cid: number }> {
  const comments: Array<{ p: string; m: string; cid: number }> = [];

  // 使用正则表达式提取所有 <d> 标签
  const dTagRegex = /<d\s+p="([^"]+)"[^>]*>([^<]*)<\/d>/g;
  let match;

  while ((match = dTagRegex.exec(xmlText)) !== null) {
    const p = match[1];
    const m = match[2];

    // 从 p 属性中提取 cid（弹幕ID）
    const pParts = p.split(',');
    const cid = pParts[7] ? parseInt(pParts[7]) : 0;

    comments.push({
      p,
      m,
      cid,
    });
  }

  return comments;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const episodeId = searchParams.get('episodeId');
    const url = searchParams.get('url');

    // 至少需要一个参数
    if (!episodeId && !url) {
      return NextResponse.json(
        {
          count: 0,
          comments: [],
        },
        { status: 400 }
      );
    }

    // 从数据库读取弹幕配置，交给带备用源降级的代理（见 lib/danmaku/proxy.ts）
    //
    // 超时给到 30s：一集弹幕要上游现抓，实测冷取 7~17 秒（热门剧单集 4 万条），
    // 给 10 秒会把正常但慢的请求误判成"源挂了"从而白白降级。
    const config = await getConfig();
    const path = episodeId
      ? `/api/v2/comment/${encodeURIComponent(episodeId)}?format=xml`
      : `/api/v2/comment?url=${encodeURIComponent(url!)}&format=xml`;
    const result = await fetchFromDanmaku(config.SiteConfig, path, {
      accept: 'application/xml, text/xml',
      timeoutMs: 30000,
      label: '弹幕',
    });

    if (!result.ok) {
      console.error(`[弹幕] 拉取失败：${danmakuFailureMessage(result)}`);
      return NextResponse.json({ count: 0, comments: [] }, { status: 502 });
    }

    const xmlText = result.text;

    // 诊断：拿到了 200 但内容根本不是 XML（比如撞上错误页 / 登录页），
    // 会被下面的解析器静默当成"0 条弹幕"，先在这里留个明确日志。
    if (!/^\s*</.test(xmlText)) {
      console.error(
        `[弹幕] ${result.sourceOrigin} 返回 200 但不是 XML（前 80 字：${xmlText.slice(0, 80).replace(/\s+/g, ' ')}）`
      );
    }

    const comments = parseXmlDanmaku(xmlText);

    return NextResponse.json({
      count: comments.length,
      comments,
    });
  } catch (error) {
    console.error('获取弹幕代理错误:', error);
    return NextResponse.json(
      {
        count: 0,
        comments: [],
      },
      { status: 500 }
    );
  }
}
