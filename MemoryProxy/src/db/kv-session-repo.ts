/**
 * KvSessionRepo —— SessionRepo backed by ProxyStorage.
 *
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6。
 *
 * Key 路径：
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json
 *
 * spaceId 是 P4 (kernel-sts) 新增的隔离段。老 caller 传空字符串时用 `_default` 兜底。
 *
 * `upsert` 是 async write-through —— caller `await` 完成后 L2a 必然已落盘。
 * 这是 2026-07-13 修复"跨节点 session-init 中间态 race → 请求透传 LLM"
 * 的直接依据（原 fire-and-forget 语义下，pod A 关流时 COS PUT 可能还在飞，
 * 落到 pod B 的 turn-2 因 L2a miss 掉入 tryHistoryScan 兜底 → bypass）。
 * 写失败保留静默降级：catch 后仅 warn，不 throw —— 上层 L1 仍是权威。
 *
 * 读接口 async，miss 返回 null，不抛。
 *
 * `loadAllInitialized`：
 *   - CosStorage 后端下强制返回 [] （关闭启动 hydrate，走 probeL2a 懒加载）
 *   - SqliteStorage / FsStorage / MemoryStorage 走 listNames + getJSON，
 *     从 key 里反解回 (spaceId, userId, agentSource, sessionId) 四段身份
 */
import type { SessionRepo, HydratedSessionRow } from "./sessionRepo.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf } from "../storage/key-utils.js";

const TTL_BUCKET_PREFIX = "ttl/";
const MAIN_FILENAME = "inj-sess.json";

function mainKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}${MAIN_FILENAME}`;
}

export class KvSessionRepo implements SessionRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    // 提前算 key —— assertKeySegment / assertAgentSource 校验会在此同步抛出，
    // 让调用方在装配层就能观测到非法参数（而不是变成静默的 async 失败）。
    const key = mainKey(spaceId, userId, agentSource, sessionId);
    try {
      await this.storage.putJSON(key, state);
    } catch (err) {
      // 静默降级：L1 仍是权威 write-through 目标；L2a 写失败不阻塞主流程。
      const e = err as { statusCode?: number; code?: string; message?: string };
      console.warn(
        `[kv-session] upsert FAIL key=${key}: ` +
          `${e?.statusCode ?? ""} ${e?.code ?? ""} ${e?.message ?? String(err)}`,
      );
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      return await this.storage.getJSON<SessionInitState>(
        mainKey(spaceId, userId, agentSource, sessionId),
      );
    } catch {
      return null;
    }
  }

  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    this.storage
      .del(mainKey(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    // CosStorage 下关闭启动 hydrate —— 全量 listObjects 太慢且价值有限
    // （多节点下只能覆盖本节点第一个请求）。走 probeL2a 懒加载即可。


    try {
      // listNames 传入 "ttl/" 前缀，返回的 name 是移除该前缀后的路径，
      // 期望形如 "<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json"。
      const names = await this.storage.listNames(TTL_BUCKET_PREFIX);
      const out: HydratedSessionRow[] = [];
      const suffix = `/${MAIN_FILENAME}`;
      for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const stem = name.slice(0, -suffix.length);
        const segs = stem.split("/");
        if (segs.length !== 4) continue;
        const [spaceId, userId, agentSource, sessionId] = segs;
        const state = await this.storage.getJSON<SessionInitState>(
          TTL_BUCKET_PREFIX + name,
        );
        if (!state || state.status !== "initialized") continue;
        out.push({ spaceId, userId, agentSource, sessionId, state });
      }
      return out;
    } catch {
      return [];
    }
  }
}
