/**
 * KvBindingRepo —— BindingRepo backed by ProxyStorage.
 *
 * 见 docs/design/2026-08-03-binding-flatten.md:
 *   - Key 路径拍平:`nottl/<spaceId>/<sessionId>/binding.json`
 *   - JSON 内部字段扩到 `userId/teamId/agentId/taskId/agentSource/userKey`,
 *     让 bridge 只凭 (spaceId, sessionId) 就能反查回完整身份
 *
 * `touchLastSeen` 从 Redis HSET 单字段变成本层 R-M-W;用 per-key mutex
 * 消除单节点内竞争。跨节点场景下 last_seen 可能覆盖丢失(业务可接受)。
 */
import type { BindingRepo, SessionBinding } from "./binding-repo.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { withPerKeyLock } from "../storage/per-key-mutex.js";
import { sessionBindingDirOf } from "../storage/key-utils.js";

function keyOf(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `${sessionBindingDirOf("nottl", sp, sessionId)}binding.json`;
}

/**
 * per-key mutex 的 lock key。原本按 4 段隔离防跨用户共 sessionId 时误串行,
 * 拍平后 (spaceId, sessionId) 就是权威 owner —— 不同 owner 的并发写本来就
 * 应该串行(后写胜出,同现存 4 段方案的最终结果一致)。
 */
function lockKey(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `binding:${sp}:${sessionId}`;
}

interface StoredBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  agentSource?: string;
  userKey?: string;
  created_at: number;
  last_seen: number;
}

export class KvBindingRepo implements BindingRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    try {
      const raw = await this.storage.getJSON<StoredBinding>(keyOf(spaceId, sessionId));
      if (!raw) return null;
      return {
        outcome: raw.outcome ?? "initialized",
        userId: raw.userId,
        teamId: raw.teamId,
        agentId: raw.agentId,
        taskId: raw.taskId,
        agentSource: raw.agentSource,
        userKey: raw.userKey,
      };
    } catch {
      return null;
    }
  }

  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      const now = Date.now();
      const record: StoredBinding = {
        outcome: binding.outcome,
        userId: binding.userId,
        teamId: binding.teamId,
        agentId: binding.agentId,
        taskId: binding.taskId,
        agentSource: binding.agentSource,
        userKey: binding.userKey,
        created_at: now,
        last_seen: now,
      };
      // Preserve `created_at` on overwrite(与 Redis HSET 语义等价:不会重置 created_at)
      const existing = await this.storage.getJSON<StoredBinding>(key).catch(() => null);
      if (existing?.created_at) record.created_at = existing.created_at;
      await this.storage.putJSON(key, record).catch((err: any) => {
        // 见 KvSessionRepo.upsert 的日志说明:失败必打日志,成功不打
        console.warn(
          `[kv-binding] putBinding FAIL key=${key}: ` +
            `${err?.statusCode ?? ""} ${err?.code ?? ""} ${err?.message ?? String(err)}`,
        );
      });
    });
  }

  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      await this.storage.del(key).catch(() => { /* silent */ });
    });
  }

  async touchLastSeen(spaceId: string, sessionId: string): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      const cur = await this.storage.getJSON<StoredBinding>(key).catch(() => null);
      if (!cur) return;
      cur.last_seen = Date.now();
      await this.storage.putJSON(key, cur).catch(() => { /* silent */ });
    });
  }
}
