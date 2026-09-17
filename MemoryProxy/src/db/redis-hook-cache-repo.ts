/**
 * RedisHookCacheRepo — Redis-backed persistence for prewarmed injection blocks.
 *
 * Implements the HookCacheRepo interface. Uses Redis Hash:
 *   inj:hook:{spaceId}:{userId}:{agentSource}:{sessionId}  Hash  field=hookId  value=ContextBlock[] JSON
 *
 * spaceId 是 P4 kernel-sts 新增的隔离段。老 caller 传空字符串时用 `_default` 兜底。
 *
 * TTL follows session lifetime (default 30min).
 * All errors degrade silently — callers treat null/no-cache as equivalent
 * to cacheStrategy=none.
 */
import type { Redis } from "ioredis";
import type { HookCacheRepo, HookCacheEntry } from "./hookCacheRepo.js";
import type { ContextBlock } from "../injection/types.js";

const KEY_PREFIX = "inj:hook:";
const DEFAULT_TTL = 30 * 60; // 30 minutes

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${KEY_PREFIX}${sp}:${userId}:${agentSource}:${sessionId}`;
}

export class RedisHookCacheRepo implements HookCacheRepo {
  private ttl: number;

  constructor(
    private redis: Redis,
    ttlSeconds?: number,
  ) {
    this.ttl = ttlSeconds ?? DEFAULT_TTL;
  }

  async put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): Promise<void> {
    const key = keyOf(spaceId, userId, agentSource, sessionId);
    await this.redis.hset(key, hookId, JSON.stringify(blocks)).catch(() => {});
    this.redis.expire(key, this.ttl).catch(() => {});
  }

  async putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const key = keyOf(spaceId, userId, agentSource, sessionId);
    const args: string[] = [];
    for (const e of entries) {
      args.push(e.hookId, JSON.stringify(e.blocks));
    }
    await this.redis.hset(key, ...args).catch(() => {});
    this.redis.expire(key, this.ttl).catch(() => {});
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    try {
      const raw = await this.redis.hget(
        keyOf(spaceId, userId, agentSource, sessionId),
        hookId,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ContextBlock[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    try {
      const all = await this.redis.hgetall(keyOf(spaceId, userId, agentSource, sessionId));
      const out: HookCacheEntry[] = [];
      for (const [hookId, raw] of Object.entries(all)) {
        try {
          const blocks = JSON.parse(raw) as ContextBlock[];
          if (Array.isArray(blocks)) {
            out.push({ hookId, blocks });
          }
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    await this.redis.del(keyOf(spaceId, userId, agentSource, sessionId)).catch(() => {});
  }
}
