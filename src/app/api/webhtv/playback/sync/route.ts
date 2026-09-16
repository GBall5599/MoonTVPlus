/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * WebHTV 观影记录同步桥
 * ============================================================
 * 让 WebHomeTV（Android App）的「观影记录同步」直接对接 MoonTVPlus，
 * 无需额外部署中转服务，两端观看进度自动互通。
 *
 * 实现的是 WebHomeTV 官方远控协议 `webhtv.playback.v1`：
 *
 *   GET  /api/webhtv/playback/sync     ← App 主动拉取增量（远控「远端同步源」填这个地址）
 *        Headers:
 *          X-WebHTV-Token:      <同步令牌>
 *          X-WebHTV-Config-Key: <当前点播接口 configKey>（仅用于日志与回显，不参与存储分区）
 *          X-WebHTV-Since:      <上次返回的 nextSince，可省>
 *          X-WebHTV-Limit:      <单次最大条数，可省，上限 1000>
 *        Response: { items: [...], deleted: [...], nextSince, hasMore }
 *
 *   POST /api/webhtv/playback/sync     ← App 主动上报（远控「Webhook 上报」填同一地址）
 *        体：WebHTV 播放进度 / 完播 / 删除事件
 *
 * 字段映射（webhtv ↔ MoonTVPlus PlayRecord）：
 *   siteKey      ←→ source_name
 *   vodId        ←→ 存储 key 里的 id（key = `${source_name}+${id}`）
 *   vodName      ←→ title
 *   vodPic       ←→ cover
 *   episodeName  ←→ index（1-based，「第N集」）
 *   positionMs   ←→ play_time × 1000（秒→毫秒）
 *   durationMs   ←→ total_time × 1000
 *   updatedAt    ←→ save_time
 *
 * 鉴权（与 /api/tvbox/subscribe 保持一致的范式）：
 *   - WEBHTV_SYNC_TOKEN 全局令牌 → 站长账号空间（自己多设备之间同步）
 *   - 用户级令牌（复用 TVBox 订阅令牌存储）→ 该用户空间（家人各自独立）
 *
 * 删除墓碑：WebHomeTV 会保留 90 天墓碑以防止离线设备用旧进度复活记录。
 * 本桥在 moonTV 侧用 localStorage/内存不可靠，故墓碑写入 records 之外的独立
 * 命名空间（Redis/存储层直接键值），键名前缀 `webhtv:tombstone:`。
 */

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import type { PlayRecord } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 墓碑保留期：与 WebHomeTV 侧的 90 天对齐，宁可长不可短 */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 单次拉取上限，防止一次拉爆 App */
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

// ---------------------------------------------------------------------------
// 令牌解析
// ---------------------------------------------------------------------------

/**
 * 把请求头里的令牌解析成 MoonTVPlus 用户名。
 * 返回 null 表示令牌无效。
 */
async function resolveUser(request: NextRequest): Promise<string | null> {
  const token =
    request.headers.get('x-webhtv-token') ||
    request.nextUrl.searchParams.get('token') ||
    '';

  if (!token) return null;

  const globalToken = process.env.WEBHTV_SYNC_TOKEN;
  if (globalToken && token === globalToken) {
    // 全局令牌 → 站长空间
    return process.env.USERNAME || 'admin';
  }

  // 用户级令牌：复用 TVBox 订阅令牌存储，家人各自一个
  try {
    const username = await db.getUsernameByTvboxToken(token);
    if (username) {
      const userInfo = await db.getUserInfoV2(username);
      if (userInfo?.banned) return null;
      return username;
    }
  } catch {
    /* 存储层不支持或查询失败，按无效令牌处理 */
  }

  return null;
}

// ---------------------------------------------------------------------------
// 墓碑存储（删除同步）
// ---------------------------------------------------------------------------

function tombstoneKey(user: string, siteKey: string, vodId: string): string {
  return `webhtv:tombstone:${user}:${siteKey}+${vodId}`;
}

/**
 * 读取墓碑表。
 *
 * 存储层没有通用 KV 接口时退化为空表（删除同步降级，进度同步不受影响）。
 *
 * 取值顺序（都做运行时存在性检查，因此对 d1 / redis / postgres / kvrocks 通用）：
 *   1) getWebhtvTombstones —— 若将来有后端提供专用接口，优先用
 *   2) getGlobalValue      —— 通用全局 KV，值类型是 string，故 JSON 序列化
 *
 * 注：早期版本曾尝试 getRaw/setRaw，但 IStorage 并未提供这两个方法，
 * 会静默退化成空表、导致删除同步完全失效。改用 getGlobalValue 后，
 * 跨设备删除也能正确同步（键：webhtv:tombstones:<user>）。
 */
function tombstoneStoreName(user: string): string {
  return `webhtv:tombstones:${user}`;
}

/** 从任意存储层取回灰度对象；失败一律返回 null（由调用方决定降级行为） */
async function readTombstones(
  user: string
): Promise<Record<string, number> | null> {
  const storage: any = (db as any).storage;
  if (!storage) return null;

  try {
    // 1) 专用接口（可选）
    if (typeof storage.getWebhtvTombstones === 'function') {
      const v = await storage.getWebhtvTombstones(user);
      return v && typeof v === 'object' ? v : {};
    }
    // 2) 通用全局 KV
    if (typeof storage.getGlobalValue === 'function') {
      const raw = await storage.getGlobalValue(tombstoneStoreName(user));
      if (!raw) return {};
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch (error) {
    // JSON 损坏或被别的代码写了非法值：当成空表，不让同步整体失败
    console.error('[webhtv-sync] 读取删除墓碑失败，按空表处理:', error);
    return null;
  }

  // 存储层两样都没有：返回 null 表示「不支持墓碑」
  return null;
}

async function writeTombstone(
  user: string,
  siteKey: string,
  vodId: string,
  deletedAt: number
): Promise<void> {
  const storage: any = (db as any).storage;
  if (!storage) return;

  try {
    const current = (await readTombstones(user)) || {};
    current[tombstoneKey(user, siteKey, vodId)] = deletedAt;

    // 顺手清理过期墓碑，避免这张表无限增长
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const k of Object.keys(current)) {
      if (!current[k] || current[k] < cutoff) delete current[k];
    }

    if (typeof storage.setWebhtvTombstones === 'function') {
      await storage.setWebhtvTombstones(user, current);
      return;
    }
    if (typeof storage.setGlobalValue === 'function') {
      await storage.setGlobalValue(
        tombstoneStoreName(user),
        JSON.stringify(current)
      );
      return;
    }
    // 两样都没有：删除同步不可用。进度同步不受影响，故只记录不抛错。
    console.warn(
      '[webhtv-sync] 当前存储后端不支持通用 KV，删除同步已降级（进度同步正常）'
    );
  } catch (error) {
    // 墓碑写失败不能阻断主流程：删除动作本身已经生效了
    console.error('[webhtv-sync] 写入删除墓碑失败（删除本身已生效）:', error);
  }
}

// ---------------------------------------------------------------------------
// 字段映射
// ---------------------------------------------------------------------------

/** MoonTVPlus 记录 → WebHTV 记录 */
function toWebhtv(
  key: string,
  rec: PlayRecord
): Record<string, unknown> | null {
  // key 形如 `source+id`；id 本身可能含 `+`，故只切第一段
  const sep = key.indexOf('+');
  if (sep <= 0) return null;
  const sourceName = key.slice(0, sep);
  const vodId = key.slice(sep + 1);
  if (!sourceName || !vodId) return null;

  // 直播记录不参与点播历史同步
  if (rec.origin === 'live') return null;

  const positionMs = Math.max(0, Math.round((rec.play_time || 0) * 1000));
  const durationMs = Math.max(0, Math.round((rec.total_time || 0) * 1000));

  // 无有效时长/进度的记录对 App 没有意义，跳过
  if (durationMs <= 0 && positionMs <= 0) return null;

  const index = Math.max(1, Math.round(rec.index || 1));

  return {
    siteKey: sourceName,
    siteName: sourceName,
    vodId,
    vodName: rec.title || '',
    vodPic: rec.cover || '',
    // WebHomeTV 用「线路名 + 集名」或「集名」匹配剧集。
    // MoonTVPlus 只存集序号，不存线路名，故统一用 1-based 的「第N集」，
    // App 侧按 episodeName 回退匹配即可命中。
    episodeName: `第${index}集`,
    positionMs,
    durationMs,
    speed: 1.0,
    completed: durationMs > 0 && positionMs >= durationMs * 0.98,
    updatedAt: rec.save_time || Date.now(),
  };
}

/** WebHTV 记录 → MoonTVPlus PlayRecord（App 上报时用） */
function toMoonTv(
  item: Record<string, any>,
  existing: PlayRecord | null
): { source: string; id: string; record: PlayRecord } | null {
  const source = String(item.siteKey || '').trim();
  const id = String(item.vodId || '').trim();
  const vodName = String(item.vodName || '').trim();
  if (!source || !id || !vodName) return null;

  const positionMs = Number(item.positionMs) || 0;
  const durationMs = Number(item.durationMs) || 0;
  if (positionMs <= 0 || durationMs <= 0) return null;

  // 从「第N集」里还原集序号；解析不出来时退回已有的 index
  let index = existing?.index ?? 1;
  const m = /第\s*(\d+)\s*[集话期]/.exec(String(item.episodeName || ''));
  if (m) {
    index = Math.max(1, parseInt(m[1], 10));
  } else if (typeof item.episodeIndex === 'number' && item.episodeIndex > 0) {
    index = Math.round(item.episodeIndex);
  }

  const record: PlayRecord = {
    title: vodName,
    source_name: source,
    cover: String(item.vodPic || existing?.cover || ''),
    year: existing?.year || '',
    index,
    total_episodes: existing?.total_episodes || Math.max(index, 1),
    play_time: Math.max(0, Math.round(positionMs / 1000)),
    total_time: Math.max(0, Math.round(durationMs / 1000)),
    save_time: Number(item.updatedAt) || Date.now(),
    search_title: existing?.search_title || vodName,
    origin: 'vod',
  };

  return { source, id, record };
}

// ---------------------------------------------------------------------------
// GET：App 拉取增量
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const user = await resolveUser(request);
  if (!user) {
    return NextResponse.json(
      { error: '无效或缺失的同步令牌' },
      { status: 401 }
    );
  }

  try {
    const sinceRaw = request.headers.get('x-webhtv-since');
    const since = sinceRaw ? Number(sinceRaw) || 0 : 0;

    const limitRaw = Number(request.headers.get('x-webhtv-limit')) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(limitRaw, 1), MAX_LIMIT);

    const all = await db.getAllPlayRecords(user);
    // null 表示当前存储后端不支持墓碑（删除同步降级），空对象表示还没有墓碑
    const tombstones = (await readTombstones(user)) || {};

    // 增量筛选：只回传比游标新的记录
    const items: Record<string, unknown>[] = [];
    for (const [key, rec] of Object.entries(all || {})) {
      if (!rec) continue;
      const updatedAt = (rec as PlayRecord).save_time || 0;
      if (since && updatedAt <= since) continue;
      const mapped = toWebhtv(key, rec as PlayRecord);
      if (mapped) items.push(mapped);
    }

    // 未过期的删除墓碑
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const deleted: Record<string, unknown>[] = [];
    for (const [tk, deletedAt] of Object.entries(tombstones)) {
      if (!deletedAt || deletedAt < cutoff) continue;
      if (since && deletedAt <= since) continue;
      // webhtv:tombstone:<user>:<siteKey>+<vodId>
      const rest = tk.slice(tk.indexOf(':', tk.indexOf(':') + 1) + 1); // 去掉前缀 webhtv:tombstone:
      const usep = rest.indexOf(':');
      const pair = usep >= 0 ? rest.slice(usep + 1) : rest;
      const sep = pair.indexOf('+');
      if (sep <= 0) continue;
      const siteKey = pair.slice(0, sep);
      const vodId = pair.slice(sep + 1);
      deleted.push({
        siteKey,
        vodId,
        historyKey: `${siteKey}@@@${vodId}`,
        scope: 'item',
        deletedAt,
      });
    }

    // 按更新时间排序，保证游标语义稳定
    items.sort(
      (a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0)
    );
    deleted.sort(
      (a, b) => Number(a.deletedAt || 0) - Number(b.deletedAt || 0)
    );

    const cut = items.slice(0, limit);
    const hasMore = items.length > cut.length;

    // 仅在全部处理完时推进游标，避免 App 漏掉被截断的条目
    const newest = [...cut, ...deleted].reduce(
      (acc, it) => Math.max(acc, Number((it as any).updatedAt || (it as any).deletedAt || 0)),
      since
    );
    const nextSince = hasMore ? since : newest;

    return NextResponse.json(
      { items: cut, deleted, nextSince, hasMore },
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    );
  } catch (error) {
    console.error('[webhtv-sync] 拉取观影记录失败:', error);
    return NextResponse.json(
      { error: '拉取观影记录失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST：App 上报（Webhook）
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const user = await resolveUser(request);
  if (!user) {
    return NextResponse.json(
      { error: '无效或缺失的同步令牌' },
      { status: 401 }
    );
  }

  try {
    const body: any = await request.json();
    const event = String(body?.event || 'playback.progress');

    // ---- 删除事件：写墓碑 ----
    if (event === 'playback.deleted') {
      const deletedAt = Number(body.deletedAt) || Date.now();
      const siteKey = String(body.siteKey || '');
      const vodId = String(body.vodId || '');

      if (siteKey && vodId) {
        await db.deletePlayRecord(user, siteKey, vodId).catch(() => {});
        await writeTombstone(user, siteKey, vodId, deletedAt);
      }

      return NextResponse.json({ success: true, action: 'deleted' });
    }

    // ---- 进度 / 完播事件：写入播放记录 ----
    const items: any[] = Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body?.records)
        ? body.records
        : [body];

    let applied = 0;
    let skipped = 0;

    // 墓碑表只在每批开始时读一次：批内多条记录之间不需要重读，
    // 之前放在循环里会对每条记录都查一次存储，条数多时是明显的浪费。
    const tombstones = (await readTombstones(user)) || {};

    for (const item of items) {
      if (!item || typeof item !== 'object') {
        skipped++;
        continue;
      }

      const siteKey = String(item.siteKey || '');
      const vodId = String(item.vodId || '');
      if (!siteKey || !vodId) {
        skipped++;
        continue;
      }

      // 被删除过的记录：比墓碑新的进度可以重新建立，旧的丢弃
      const ts = tombstones[tombstoneKey(user, siteKey, vodId)] || 0;
      const updatedAt = Number(item.updatedAt) || Date.now();
      if (ts && updatedAt <= ts) {
        skipped++;
        continue;
      }

      const existing = await db
        .getPlayRecord(user, siteKey, vodId)
        .catch(() => null);

      // 冲突处理：远端不比本地新则跳过（与 WebHomeTV 侧一致的规则）
      if (existing) {
        const localAt = existing.save_time || 0;
        if (localAt && updatedAt <= localAt) {
          skipped++;
          continue;
        }
      }

      const mapped = toMoonTv(item, existing);
      if (!mapped) {
        skipped++;
        continue;
      }

      await db.savePlayRecord(user, mapped.source, mapped.id, mapped.record);
      applied++;
    }

    return NextResponse.json({
      success: true,
      total: items.length,
      applied,
      skipped,
    });
  } catch (error) {
    console.error('[webhtv-sync] 写入观影记录失败:', error);
    return NextResponse.json(
      { error: '写入观影记录失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
