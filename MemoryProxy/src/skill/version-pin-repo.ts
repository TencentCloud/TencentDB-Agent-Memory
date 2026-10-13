/**
 * VersionPinRepo — Redis-backed skill version snapshot for lazy-pin.
 *
 * Each session gets a hash key: skill:vpin:{userId}:{agentSource}:{sessionId}
 *   HSET skill:vpin:u1:claude-code:sess123 skl-abc 3 skl-xyz 5
 *   EXPIRE skill:vpin:u1:claude-code:sess123 <ttl>
 *
 * "Only write if not exists" semantics are enforced by Lua script to avoid
 * race conditions between concurrent first-access requests within the same session.
 *
 * All errors degrade silently — lazy-pin is best-effort.
 */
import type { Redis } from "ioredis";

const KEY_PREFIX = "skill:vpin:";
const DEFAULT_TTL = 30 * 60; // 30 minutes

function keyOf(
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  return `${KEY_PREFIX}${userId}:${agentSource}:${sessionId}`;
}

export interface VersionPinPipeline {
  hset(key: string, field: string, value: string): unknown;
  expire(key: string, seconds: number): unknown;
  exec(): Promise<unknown>;
}

export interface VersionPinRedisClient {
  hget(key: string, field: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  multi(): VersionPinPipeline;
}

export class VersionPinRepo {
  private ttl: number;

  constructor(
    private redis: VersionPinRedisClient | null,
    ttlSeconds?: number,
  ) {
    this.ttl = ttlSeconds ?? DEFAULT_TTL;
  }

  /** Get pinned version for a single skill_id in this session. */
  async getVersion(
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
  ): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.hget(keyOf(userId, agentSource, sessionId), skillId);
      if (!raw) return null;
      const n = Number(raw);
      return isNaN(n) ? null : n;
    } catch {
      return null;
    }
  }

  /**
   * Pin multiple skill_id→version pairs for a session.
   *
   * Only writes keys that do NOT already exist in the hash (HSETNX semantics).
   * This ensures the first-pinned version for each skill_id is authoritative
   * and won't be overwritten by subsequent pins within the same session.
   *
   * TTL is refreshed on every call.
   */
  async pinMany(
    userId: string,
    agentSource: string,
    sessionId: string,
    pairs: Array<{ skillId: string; version: number }>,
  ): Promise<void> {
    if (!this.redis || pairs.length === 0) return;
    try {
      const key = keyOf(userId, agentSource, sessionId);
      // Lua: HSETNX each field, then refresh EXPIRE.
      // Atomically ensures "only write if not exists" for each field.
      const script = `
        local key = KEYS[1]
        local ttl = tonumber(ARGV[1])
        for i = 2, #ARGV, 2 do
          if redis.call('HEXISTS', key, ARGV[i]) == 0 then
            redis.call('HSET', key, ARGV[i], ARGV[i+1])
          end
        end
        redis.call('EXPIRE', key, ttl)
        return 1
      `;
      const args: (string | number)[] = [String(this.ttl)];
      for (const p of pairs) {
        args.push(p.skillId, String(p.version));
      }
      await this.redis.eval(script, 1, key, ...args);
    } catch {
      // silent — lazy-pin is best-effort
    }
  }

  /**
   * Upsert (overwrite) a skill's pinned version.
   *
   * Used after successful write ops (update/patch/files_write/files_remove) —
   * plugin returned v+1 as the new head, and we want subsequent reads/writes
   * in the same session to align with that new version (not the old one we
   * had pinned pre-write).
   *
   * TTL is refreshed on every call.
   */
  async upsertVersion(
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
    version: number,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = keyOf(userId, agentSource, sessionId);
      const pipeline = this.redis.multi();
      pipeline.hset(key, skillId, String(version));
      pipeline.expire(key, this.ttl);
      await pipeline.exec();
    } catch {
      // silent
    }
  }
}
