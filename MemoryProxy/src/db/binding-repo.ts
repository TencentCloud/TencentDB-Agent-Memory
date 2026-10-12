/**
 * BindingRepo — 长期 session binding 持久化。
 *
 * 在 KV 里存一份"小纸条",只记 outcome + id 组,永不自动清理(`nottl/` 前缀)。
 * 用于沉睡对话唤醒 + bridge L2 反查身份。
 *
 * ── Signature note ────────────────────────────────────────────────────────
 * 见 docs/design/2026-08-03-binding-flatten.md:
 *   - 原方案 (2026-07-10) 用 `(userId, agentSource, sessionId)` 三段作 key,
 *     加上 P4 (2026-07-12 kernel-sts) 的 `spaceId` 一共 4 段
 *   - 但 bridge 侧 curl 只能给 (spaceId, sessionId) —— 拿不到 userId/agentSource,
 *     跨 pod L1 miss 时永远拼不出老 key,401 到底
 *   - 拍平后:方法签名减到 `(spaceId, sessionId)`,userId/agentSource 挪到
 *     `SessionBinding` 结构体里,`userKey` 也一起存进去(memory-bridge L2b
 *     恢复后 chat_memory 检索不再降级)
 */

import type { Redis } from "ioredis";

const REDIS_KEY_PREFIX = "inj:binding:";
const DEFAULT_BINDING_TTL_DAYS = 30;

export interface SessionBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  /**
   * URL path 侧的 agent 前缀(`claude-code` / `codebuddy` ...)。session init
   * 落盘时从 identity 里带过来,bridge 反查时用它 stamp 到 outbound。
   */
  agentSource?: string;
  /**
   * 用户 apiKey。memory-bridge 恢复 chat_memory 检索时要用它去 kernel
   * 查 imported agents(见 `memory-bridge.ts:resolveMemoryCtxs`),缺失
   * 会静默降级成 self-only。老 4 段路径不带这个字段,恢复后必降级 ——
   * 拍平后一起存进来,顺手修好。
   */
  userKey?: string;
}

export interface BindingRepo {
  getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null>;
  putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void>;
  deleteBinding(spaceId: string, sessionId: string): Promise<void>;
  touchLastSeen(spaceId: string, sessionId: string): Promise<void>;
}

function ttlSeconds(days: number): number {
  return days * 86400;
}

function redisKey(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `${REDIS_KEY_PREFIX}${sp}:${sessionId}`;
}

export class RedisBindingRepo implements BindingRepo {
  constructor(
    private redis: Redis,
    private bindingTtlDays: number = DEFAULT_BINDING_TTL_DAYS,
  ) {}

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    try {
      const all = await this.redis.hgetall(redisKey(spaceId, sessionId));
      if (!all || Object.keys(all).length === 0) return null;
      return {
        outcome: (all.outcome as "initialized" | "bypassed") || "initialized",
        userId: all.user_id || undefined,
        teamId: all.team_id || undefined,
        agentId: all.agent_id || undefined,
        taskId: all.task_id || undefined,
        agentSource: all.agent_source || undefined,
        userKey: all.user_key || undefined,
      };
    } catch {
      return null;
    }
  }

  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    const now = Date.now().toString();
    try {
      const fields: Record<string, string> = {
        outcome: binding.outcome,
        created_at: now,
        last_seen: now,
      };
      if (binding.userId) fields.user_id = binding.userId;
      if (binding.teamId) fields.team_id = binding.teamId;
      if (binding.agentId) fields.agent_id = binding.agentId;
      if (binding.taskId) fields.task_id = binding.taskId;
      if (binding.agentSource) fields.agent_source = binding.agentSource;
      if (binding.userKey) fields.user_key = binding.userKey;

      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, fields);
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }

  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(redisKey(spaceId, sessionId));
    } catch {
      /* ignore */
    }
  }

  async touchLastSeen(spaceId: string, sessionId: string): Promise<void> {
    try {
      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, "last_seen", Date.now().toString());
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }
}

/** Null repo for when Redis is disabled. */
export class NullBindingRepo implements BindingRepo {
  async getBinding(_spaceId: string, _sessionId: string): Promise<SessionBinding | null> { return null; }
  async putBinding(_spaceId: string, _sessionId: string, _binding: SessionBinding): Promise<void> {}
  async deleteBinding(_spaceId: string, _sessionId: string): Promise<void> {}
  async touchLastSeen(_spaceId: string, _sessionId: string): Promise<void> {}
}
