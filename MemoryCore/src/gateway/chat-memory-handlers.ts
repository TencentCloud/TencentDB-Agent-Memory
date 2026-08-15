/**
 * /v3/chat-memory/* HTTP handlers — Chat Memory 内容清空。
 *
 * 设计要点：
 *   - `clear` 只删**内容**，不删资产。asset_id、Team/Agent 归属、Agent 绑定、
 *     ACL、Owner、名称、可见性全部保留，清空后 Agent 继续用原 memory_id 写入。
 *   - 任一 memory_id 不存在 / 非 chat_memory / 无法定位 agent 时整批拒绝
 *     （前置解析全部通过后才开始删除）。
 *   - 幂等：已清空过的 memory_id 再次调用仍返回成功，计数为 0。
 *   - 审计：每个 memory_id 按 L1/L2/L3 各记一条 delete 事件，只记
 *     memory_id + 时间 + 结果，**不保留任何原内容**。
 *
 * 鉴权模型（与 L0–L3 数据面一致）：
 *   内核把 Bearer + x-tdai-service-id 视为可信的管理员级凭据，**不做用户级
 *   鉴权**、不解析 x-tdai-user-key —— 与 conversation/delete、atomic/delete
 *   等同类删除接口保持一致。"仅资产 Owner 可操作"由**面板后端**在转发前完成
 *   （见 MemoryPanel routes/chat-memory.ts 的 NOT_ASSET_OWNER 校验）。
 *
 * 注册方式与 /v3/skill/*、/v3/knowledge/* 一致（extraRouteTable），
 * 因此绕过 L0–L3 的 strict-isolation 三元组校验 —— 本接口的作用域由
 * memory_ids 自身决定，不依赖请求头里的 agent/session。
 */

import { randomUUID } from "node:crypto";

import { ZodError, z } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore, MemoryContentClearResult } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/types.js";
import { createScopedStorageAdapter } from "../core/storage/adapter.js";
import { buildProfileIsolationScope } from "../core/profile/profile-sync.js";
import { MetadataError, type MetadataService } from "../metadata/service/metadata-service.js";
import type { Logger } from "../core/types.js";

const TAG = "[chat-memory-handlers]";

/** 单次clear 的 memory_ids 上限。 */
export const CHAT_MEMORY_CLEAR_MAX = 100;

// ═════════════════════════════════════════════════════════════
//  Schema
// ═════════════════════════════════════════════════════════════

export const chatMemoryClearRequestSchema = z.object({
  memory_ids: z.array(z.string()).min(1).max(CHAT_MEMORY_CLEAR_MAX),
}).transform((data) => {
  const seen = new Set<string>();
  const memoryIds: string[] = [];
  for (const raw of data.memory_ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    memoryIds.push(id);
  }
  return { memory_ids: memoryIds };
}).refine(
  (data) => data.memory_ids.length > 0,
  { message: "memory_ids must contain at least one non-empty id" },
);

/** 单个 memory 的清空结果。 */
export interface ChatMemoryClearItem {
  memory_id: string;
  /** 清空是否成功。失败时 memory_id 内容可能残留，调用方可重试（幂等）。 */
  cleared: boolean;
  l0_deleted: number;
  l1_deleted: number;
  /** L2/L3 profile 记录数（VDB 行 + 存储文件）。 */
  profile_deleted: number;
  /** 失败原因；成功时不返回。 */
  reason?: string;
  /**
   * 失败是否值得重试。
   *
   * 清空是幂等的，所以内部已自动重试若干次；这里为 true 表示重试仍未成功
   * （通常是 VDB/COS 持续不可用），调用方稍后再试即可补齐残留内容。
   * 参数类错误等不可重试的失败为 false。
   */
  retryable?: boolean;
  /** 内部实际尝试次数，便于排查。 */
  attempts?: number;
}

export interface ChatMemoryClearData {
  items: ChatMemoryClearItem[];
  /** 全部成功时为 true。 */
  all_cleared: boolean;
}

// ═════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════

export interface ChatMemoryRouterDeps {
  getStore: () => IMemoryStore | undefined;
  getStorage: () => StorageAdapter | undefined;
  getMetadataService?: (instanceId: string) => Promise<MetadataService>;
  logger: Logger;
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** MetadataError.code → envelope code。与 v3-meta-router 的映射保持一致的语义。 */
function metadataErrorCode(code: string): number {
  if (code === "permission_denied") return 403;
  if (code.endsWith("_not_found")) return 404;
  return 400;
}

// ═════════════════════════════════════════════════════════════
//  Clear
// ═════════════════════════════════════════════════════════════

/**
 * 删除该 (team, agent) 作用域下的全部 L2/L3 存储对象。
 *
 * 存储按 profile scope 前缀隔离（`profiles/<scope>/`），所以直接按前缀整体
 * 删除，覆盖 persona.md、scene_blocks/、.metadata/scene_index.json 及任何
 * 派生文件；不会越出该 (team, agent) 的作用域。
 *
 * 返回被删除的对象数（用于审计计数）。失败向上抛，由调用方标记该memory 失败。
 */
async function clearProfileStorage(
  baseStorage: StorageAdapter,
  teamId: string,
  agentId: string,
): Promise<number> {
  // ⚠️ 必须自己校验，不能依赖调用方。
  // buildProfileIsolationScope 对空值会静默兜底成 "default"，拼出
  // `team:default|agent:default` 这个**看起来合法**的作用域 —— 一旦
  // teamId/agentId 为空，就会去删公共 default 作用域的数据，而不是报错。
  const team = (teamId ?? "").trim();
  const agent = (agentId ?? "").trim();
  if (!team || !agent) {
    throw new Error(
      "clearProfileStorage requires non-empty teamId and agentId " +
      "(empty values would silently target the shared \"default\" profile scope)",
    );
  }

  const scope = buildProfileIsolationScope({ teamId: team, agentId: agent });
  // 作用域前缀与 v2-router scopedProfileStorage 保持完全一致，
  // 否则会清到错误的目录（或清不到）。
  const scopePrefix = `profiles/${encodeURIComponent(scope)}/`;
  const storage = createScopedStorageAdapter(baseStorage, scopePrefix);

  // 先数再删：deleteByPrefix 的返回值各 backend 语义不完全统一，
  // 这里用 list 的结果作为审计计数的权威来源。
  let removed = 0;
  try {
    const entries = await storage.readdir("");
    removed = entries.filter((e) => !e.isDirectory).length;
  } catch { /* 作用域尚不存在 → 视为已清空 */ }

  // 空字符串前缀经scoped adapter 的 key() 拼接后是 `profiles/<scope>/`，
  // 永远非空，不会越界到其他 agent，也不会命中 backend 的空 key 保护。
  await storage.rmdir("");

  return removed;
}

/**
 * 清空一个 (team, agent) 的 chat_memory **内容**：L0/L1/L2/L3 + 向量 + 文件。
 * 只删内容，**不动任何资产记录**（asset / 绑定 / ACL 由调用方各自决定）。
 *
 * 两个调用方共用这一份实现，避免两套清理逻辑走偏：
 *   - `/v3/chat-memory/clear` —— 清完保留资产，Agent 继续用原 memory_id
 *   - `MetadataService.archiveAgent` —— 清完再删资产（删Agent 场景）
 *
 * 失败向上抛，由调用方决定是标记单条失败还是中止整个流程。
 */
export async function clearChatMemoryContent(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  // 入口处自校验：这是破坏性操作，且有两个调用方，不能依赖上游都做过校验。
  const teamId = (args.teamId ?? "").trim();
  const agentId = (args.agentId ?? "").trim();
  if (!teamId || !agentId) {
    throw new Error("clearChatMemoryContent requires non-empty teamId and agentId");
  }

  if (typeof args.store.clearMemoryContent !== "function") {
    throw new Error("store does not support clearMemoryContent");
  }
  const result: MemoryContentClearResult = await args.store.clearMemoryContent({
    teamId,
    agentId,
  });
  const filesRemoved = await clearProfileStorage(args.storage, teamId, agentId);
  return {
    l0Deleted: result.l0Deleted,
    l1Deleted: result.l1Deleted,
    profileDeleted: result.profilesDeleted + filesRemoved,
  };
}

/** 清空内容的整体重试次数上限（含首次尝试）。 */
export const CLEAR_MAX_ATTEMPTS = 3;
/** 重试退避基数（毫秒），实际等待为 BASE * 2^(n-1)。 */
const CLEAR_RETRY_BASE_DELAY_MS = 300;

/**
 * 判断错误是否值得重试。
 *
 * 不可重试的是**入参/契约类错误** —— 重试一万次结果也一样，只会拖长请求。
 * 其余（VDB 超时、COS 5xx、连接重置等）都当作瞬时故障重试。
 */
function isNonRetryableClearError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // 入参为空 —— 调用方 bug，重试无意义
    msg.includes("requires non-empty teamId and agentId")
    || msg.includes("requires a non-empty sessionId")
    // store 能力缺失 —— 配置问题
    || msg.includes("does not support clearMemoryContent")
    // 护栏拦下的危险 filter —— 属于代码缺陷，必须暴露而不是重试掩盖
    || msg.includes("refusing clearMemoryContent")
    || msg.includes("would wipe the whole collection")
    || msg.includes("missing required scope field")
  );
}

/**
 * 带整体重试的内容清空。
 *
 * 为什么在**这一层**重试，而不是只依赖 TcvdbClient 的单请求重试：
 * 单请求重试只能覆盖"某一次 HTTP 调用抖动"，但清空是 L0→L1→profiles→存储
 * 四步，任何一步彻底失败都会留下"半清空"状态。清空天然幂等（按 filter 删，
 * 删过的再删返回 0），所以整体重跑是安全的，能把半清空收敛成全清空。
 *
 * 失败时抛出最后一次的错误，并在 message 前缀标注尝试次数，便于排查。
 */
async function clearChatMemoryContentWithRetry(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
  memoryId: string;
}): Promise<{
  result: { l0Deleted: number; l1Deleted: number; profileDeleted: number };
  attempts: number;
}> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= CLEAR_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await clearChatMemoryContent({
        store: args.store,
        storage: args.storage,
        teamId: args.teamId,
        agentId: args.agentId,
      });
      if (attempt > 1) {
        args.logger.info(
          `${TAG} clear succeeded on attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} memory=${args.memoryId}`,
        );
      }
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;

      if (isNonRetryableClearError(err)) {
        args.logger.error(
          `${TAG} clear failed with non-retryable error memory=${args.memoryId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      if (attempt < CLEAR_MAX_ATTEMPTS) {
        const delay = CLEAR_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        args.logger.warn(
          `${TAG} clear attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} failed memory=${args.memoryId}, ` +
          `retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

/**
 * 带整体重试的清空，供 `archiveAgent`（删除 Agent 时连带清内容）复用。
 *
 * 与 clear 接口共用同一套重试策略，保证两条路径行为一致：都能自愈瞬时
 * VDB/COS 故障，且都不会用重试掩盖参数类错误。
 */
export async function clearChatMemoryContentResilient(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  const { result } = await clearChatMemoryContentWithRetry({
    ...args,
    memoryId: `${args.teamId}/${args.agentId}`,
  });
  return result;
}

/**
 * 写清空审计。L1/L2/L3 各一条 delete 事件，record_id 用 memory_id（asset_id），
 * 不写任何原内容。审计失败不阻塞主流程（与 v2-router recordAudit 语义一致）。
 */
export async function recordClearAudit(
  store: IMemoryStore,
  args: {
    memoryId: string;
    teamId: string;
    agentId: string;
    requestId: string;
    logger: Logger;
  },
): Promise<void> {
  if (!store.appendAudit) return;
  const now = Date.now();
  for (const layer of ["L1", "L2", "L3"] as const) {
    try {
      await store.appendAudit({
        audit_id: `audit-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        record_id: args.memoryId,
        layer,
        action: "delete",
        team_id: args.teamId,
        agent_id: args.agentId,
        version: 0,
        updated_at_ms: now,
        request_id: args.requestId,
      });
    } catch (err) {
      args.logger.warn(
        `${TAG} audit append failed (clear/${layer} memory=${args.memoryId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function handleChatMemoryClear(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  depsRaw: unknown,
): Promise<ApiResponseEnvelope> {
  const deps = depsRaw as ChatMemoryRouterDeps;
  const parsed = chatMemoryClearRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const { memory_ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (typeof store.clearMemoryContent !== "function") {
    return errorEnvelope(503, "Store does not support chat memory clear", requestId);
  }
  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);
  if (!deps.getMetadataService) {
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  let metaSvc: MetadataService;
  try {
    metaSvc = await deps.getMetadataService(auth.serviceId);
  } catch (err) {
    deps.logger.warn(`${TAG} metadata service unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  // ── 前置整批解析：asset 存在 + asset_type=chat_memory + 可定位 agent。
  //    任一失败整批拒绝，一条都不清。
  //
  //    这里**不做用户级 Owner 校验** —— 与 L0–L3 数据面保持一致的信任模型：
  //    内核数据面把 Bearer + x-tdai-service-id 视为可信（管理员级）凭据，
  //    不解析 x-tdai-user-key。"仅资产 Owner 可操作"由**面板后端**在转发前
  //    完成（见 MemoryPanel routes/chat-memory.ts 的 NOT_ASSET_OWNER 校验）。
  //    在内核再做一遍会造成：① 与同类删除接口(conversation/atomic delete)
  //    行为不一致；② 服务端调用方（无用户上下文）无法使用本接口。
  let targets: Array<{ asset_id: string; team_id: string; agent_id: string }>;
  try {
    targets = await metaSvc.resolveChatMemoryTargets(memory_ids);
  } catch (err) {
    if (err instanceof MetadataError) {
      return errorEnvelope(metadataErrorCode(err.code), err.message, requestId);
    }
    throw err;
  }

  // ── 逐个清空内容。校验已全部通过，这里的失败只可能是存储/VDB 故障，
  //    所以带整体重试（清空幂等，重跑安全）。 ──
  const items: ChatMemoryClearItem[] = [];
  for (const target of targets) {
    try {
      const { result, attempts } = await clearChatMemoryContentWithRetry({
        store,
        storage,
        teamId: target.team_id,
        agentId: target.agent_id,
        logger: deps.logger,
        memoryId: target.asset_id,
      });

      await recordClearAudit(store, {
        memoryId: target.asset_id,
        teamId: target.team_id,
        agentId: target.agent_id,
        requestId,
        logger: deps.logger,
      });

      items.push({
        memory_id: target.asset_id,
        cleared: true,
        l0_deleted: result.l0Deleted,
        l1_deleted: result.l1Deleted,
        profile_deleted: result.profileDeleted,
        ...(attempts > 1 ? { attempts } : {}),
      });
    } catch (err) {
      // 不回滚：清空本身是幂等的，调用方重试即可补齐残留。
      // 只落安全信息，不把底层错误原文透给调用方。
      const retryable = !isNonRetryableClearError(err);
      deps.logger.error(
        `${TAG} clear failed memory=${target.asset_id} team=${target.team_id} ` +
        `agent=${target.agent_id} retryable=${retryable}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      items.push({
        memory_id: target.asset_id,
        cleared: false,
        l0_deleted: 0,
        l1_deleted: 0,
        profile_deleted: 0,
        reason: retryable
          ? `clear failed after ${CLEAR_MAX_ATTEMPTS} attempts, please retry later`
          : "clear rejected due to invalid request or server configuration",
        retryable,
        attempts: retryable ? CLEAR_MAX_ATTEMPTS : 1,
      });
    }
  }

  return successEnvelope<ChatMemoryClearData>({
    items,
    all_cleared: items.every((i) => i.cleared),
  }, requestId);
}

// ═════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

export function makeChatMemoryRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/chat-memory/clear": handleChatMemoryClear,
  };
}

export { handleChatMemoryClear };
