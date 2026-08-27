/**
 * KvHookCacheRepo —— HookCacheRepo backed by ProxyStorage.
 *
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6。
 *
 * Key 路径：
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-hook/<hookId>.json
 *
 * spaceId 是 P4 (kernel-sts) 新增的隔离段。老 caller 传空字符串时用 `_default` 兜底。
 *
 * QPS 放大警告：`putMany` 从 1 次 HSET 变成 N 次并发 PUT；`getAllForSession`
 * 从 1 次 HGETALL 变成 1 次 LIST + N 次 GET。注入层通常 3–5 个 hookId/session，
 * 可接受；压测发现瓶颈可退化为整 session 打包。
 */
import type { HookCacheRepo, HookCacheEntry } from "./hookCacheRepo.js";
import type { ContextBlock } from "../injection/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf, assertKeySegment } from "../storage/key-utils.js";

function hookDir(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}inj-hook/`;
}

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  hookId: string,
): string {
  assertKeySegment("hookId", hookId);
  return `${hookDir(spaceId, userId, agentSource, sessionId)}${hookId}.json`;
}

export class KvHookCacheRepo implements HookCacheRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): Promise<void> {
    await this.storage
      .putJSON(keyOf(spaceId, userId, agentSource, sessionId, hookId), blocks)
      .catch(() => { /* silent */ });
  }

  async putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    // 并发 PUT —— 保持 wall-clock ≈ 单次 PUT，而不是 N 倍串行
    await Promise.all(
      entries.map((e) =>
        this.storage
          .putJSON(keyOf(spaceId, userId, agentSource, sessionId, e.hookId), e.blocks)
          .catch(() => { /* silent */ }),
      ),
    );
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    try {
      return await this.storage.getJSON<ContextBlock[]>(
        keyOf(spaceId, userId, agentSource, sessionId, hookId),
      );
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
      const dir = hookDir(spaceId, userId, agentSource, sessionId);
      const names = await this.storage.listNames(dir);
      const out: HookCacheEntry[] = [];
      const settled = await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n) => {
            const blocks = await this.storage
              .getJSON<ContextBlock[]>(dir + n)
              .catch(() => null);
            if (!Array.isArray(blocks)) return null;
            return { hookId: n.slice(0, -".json".length), blocks };
          }),
      );
      for (const e of settled) if (e) out.push(e);
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
    await this.storage
      .delPrefix(hookDir(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }
}
