/**
 * /skill/* HTTP handlers — v3 (migrated from v2, 2026-06-17).
 *
 * 设计文档对应：docs/design/2026-06-17-skill-redesign-v2.md §3.5 / §3.6。
 *
 * 错误码映射（核心层 SkillCoreError → HTTP envelope code）：
 *   INVALID_FRONTMATTER       → 40001  (frontmatter.name 与 body/head 不一致)
 *   INVALID_PATH              → 40001
 *   SKILL_NOT_OWNER           → 40301
 *   SKILL_TEAM_MISMATCH       → 40302
 *   SKILL_NOT_FOUND           → 40401
 *   SKILL_VERSION_STALE       → 40901
 *   RESOURCE_TOO_LARGE        → 41301
 *   SKILL_NAME_DUPLICATE      → 42201
 *   SKILL_PATCH_NOT_UNIQUE    → 42202
 *   SKILL_FRONTMATTER_INVALID → 42203  (frontmatter parse / 长度 / regex)
 *   STORAGE_NOT_FOUND         → 50301  (版本目录被 GC)
 *   QUEUE_UNAVAILABLE         → 50301  (extract 时队列未就绪)
 *   LLM_UNAVAILABLE           → 50302  (LLM 不可用)
 *   其他                       → 50001
 */

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import {
  createRequestSchema,
  updateRequestSchema,
  patchRequestSchema,
  deleteRequestSchema,
  getRequestSchema,
  getByNameRequestSchema,
  listRequestSchema,
  searchRequestSchema,
  versionsRequestSchema,
  filesWriteRequestSchema,
  filesRemoveRequestSchema,
  filesReadRequestSchema,
  listingRequestSchema,
  extractRequestSchema,
  exportRequestSchema,
  conversationAddRequestSchema,
  forceArchiveRequestSchema,
} from "./skill-schemas.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { SkillCoreError, type SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { Logger } from "../core/types.js";
import type { Skill, ResolvedSkillConfig } from "../core/skill/types.js";
import { DEFAULT_COMPRESS_OPTIONS } from "../core/skill/conversation-add/message-compressor.js";
import { DEFAULT_OVERSIZE_OPTIONS } from "../core/skill/conversation-add/oversize-strategy.js";
import { prepareArchivePayload } from "../core/skill/conversation-add/prepare-archive.js";
import type { CompressibleMessage } from "../core/skill/conversation-add/message-compressor.js";
import { trace } from "../core/report/trace.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { obsLogger } from "../core/report/obs-logger.js";

const TAG = "[skill-handlers]";

// [obs] 观测埋点全部走 obsLogger 底座（`src/core/report/obs-logger.ts`）；
// 事件名 `skill.<xxx>.done` / `skill.<xxx>.<phase>` 直接字面量写，字段直接
// inline 字典。undefined 值直接传，不加过滤 —— 跟仓库其他模块（e.g.
// core/report/traced-task-executor.ts）保持完全一致。降级由 obsLogger 内
// 部 try/catch 提供，业务代码不加额外防御。

// ═════════════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════════════

export interface SkillRouterDeps {
  getSkillCore: () => SkillCore | undefined;
  /** Optional. 抽取器实例（供 worker 内部驱动）。 */
  getSkillExtractor?: () => SkillExtractor | undefined;
  /** Optional. 已解析的 skill 配置；handleListing 用 searchTopK 限制注入条目数。 */
  getResolvedSkillConfig?: () => ResolvedSkillConfig | undefined;
  logger: Logger;
  /**
   * Service mode: resolve per-instance SkillCore (TcvdbSkillStore + COS).
   * When provided, takes precedence over getSkillCore() for /v3/skill/* requests
   * that carry x-tdai-service-id.
   */
  resolveSkillCore?: (instanceId: string) => Promise<SkillCore | undefined>;
  /** Quota manager for skill count limit checks (like memory's checkMemoryQuota). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;
  /**
   * Service mode: build a SkillExtractor for a given SkillCore.
   * 传入 per-instance SkillCore（TCVDB + COS）+ 当次请求的 instanceId，返回 extractor。
   * 用于 service 模式下 /v3/skill/extract 的同步抽取，替代 standalone 的队列异步模式。
   *
   * `instanceId` 会传给 `resolveStandaloneLlmForRuntime` 以拼出
   * `${baseUrl}/proxy/<instanceId>/v1` —— 缺少它会导致 `provider=proxy`
   * 场景下 skill extractor 直接打错 upstream URL。
   */
  buildSkillExtractor?: (
    core: SkillCore,
    instanceId: string,
  ) => SkillExtractor | Promise<SkillExtractor>;
  /**
   * 拿到 (per instance) 的 MetadataService。用于 handleCreate 成功后自动登记
   * skill 资产（asset_id === skill_id）并绑定到 owner agent 的 fixed-asset。
   *
   * standalone 模式下 SkillCore 是 TdaiCore 全局构造的（不带钩子），所以由 handler
   * 层做这个登记；service 模式下 buildSkillCore 里的 onSkillCreated 钩子会做同样的
   * 事（幂等，重复调用无副作用）。两条路径都覆盖，保证前端管控页永远能看到 skill。
   *
   * 语义与 v2-router 里 handleConversationAdd 用同一 dep 自动登记 chat_memory 资产
   * 一致（详见 v2-router.ts:648 及 metadata-service.ts:ensureSkillAsset）。
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
  /**
   * `POST /v3/skill/conversation/add` + `POST /v3/skill/extract`
   * 共用的 wired 结果提供者。返回一整套 { handler, trigger, buffer, ... }：
   *   - handleConversationAdd 用 .handler
   *   - handleExtract 用 .trigger
   *
   * Service 模式下每租户各持一份；standalone 模式返回单例。由 wiring 层
   * (server.ts) 按 auth.serviceId 缓存 + resolve。
   */
  resolveConversationAdd?: (instanceId: string) => Promise<
    import("../core/skill/conversation-add/wire.js").WiredConversationAddHandler | undefined
  >;
  /**
   * 可选. Analytics ClickHouse 只读客户端 (跟 /v3/analytics/* 复用同一 lazy singleton)。
   * 用于 `handleListing` 的 `mode='activity'` 分支读 `skill_usage_logs` 计算 MRR。
   *
   * 未提供 / 返回 null → activity 模式直接 fallback 到原 BM25/full 逻辑, 主链路无感知。
   *
   * 设计: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
   */
  getAnalyticsChClient?: () => Promise<
    import("./analytics/analytics-ch-client.js").AnalyticsChClient | null
  >;
}

// ═════════════════════════════════════════════════════════════════════
//  错误映射
// ═════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<string, number> = {
  INVALID_FRONTMATTER: 40001,
  INVALID_PATH: 40001,
  SKILL_NOT_OWNER: 40301,
  SKILL_TEAM_MISMATCH: 40302,
  SKILL_NOT_FOUND: 40401,
  SKILL_VERSION_STALE: 40901,
  RESOURCE_TOO_LARGE: 41301,
  SKILL_NAME_DUPLICATE: 42201,
  SKILL_PATCH_NOT_UNIQUE: 42202,
  SKILL_FRONTMATTER_INVALID: 42203,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  SKILL_COS_REQUIRED: 50303,
  SKILL_ID_COLLISION: 50304,
  SKILL_VERSION_EXPIRED: 41002,
  SKILL_EXPORT_TOO_LARGE: 41301,
};

function mapCoreError(e: unknown, requestId: string, deps?: SkillRouterDeps, meta?: Record<string, unknown>): ApiResponseEnvelope {
  if (e instanceof SkillCoreError) {
    const code = ERROR_CODE_MAP[e.code] ?? 50001;

    // 版本冲突时记录 warn 日志，便于后续统计冲突频率
    if (e.code === "SKILL_VERSION_STALE" && deps) {
      deps.logger.warn(
        `${TAG} version_conflict requestId=${requestId} skill_id=${meta?.skill_id ?? "?"} ` +
        `expected_version=${meta?.expected_version ?? "?"} detail="${e.message}"`,
      );
    }

    // 版本冲突 409 响应里额外带上 current_version，方便调用方重试
    if (e.code === "SKILL_VERSION_STALE") {
      const match = e.message?.match(/head is (\d+)/);
      const currentVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { current_version: currentVersion });
    }

    // 版本过期 410 响应里额外带上 latest_version，方便调用方升级
    if (e.code === "SKILL_VERSION_EXPIRED") {
      const match = e.message?.match(/latest version v(\d+)/);
      const latestVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { latest_version: latestVersion });
    }

    return errorEnvelope(code, e.message, requestId);
  }
  return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ═════════════════════════════════════════════════════════════════════
//  共享前置
// ═════════════════════════════════════════════════════════════════════

/**
 * 统一前置校验：优先通过 resolveSkillCore(auth.serviceId) 获取
 * per-instance SkillCore（TCVDB + COS），fallback 到 getSkillCore()（standalone）。
 *
 * 修复 (2026-07-04)：service 模式下 read handlers 之前只用 getSkillCore()（standalone
 * SQLite），导致写入 per-instance TCVDB 后读却查空 SQLite。现在读/写路径对齐同一套
 * store 解析逻辑。
 */
async function precheck<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

/**
 * 写路径的 precheck：与 precheck 逻辑完全一致，只是名字更明确表达"写入语义"。
 * 保留以维持既有 handler 命名一致性；两者可以合并，但先保持向后兼容。
 */
async function precheckWrite<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

// 把 Skill 行形成 SkillSummary 形态（不带 content；带 manifest 当 detail 时再加）
// 字段对齐设计文档 §3.4 SkillSummary。
/** 反序列化 skill.metadata_json 到 metadata 对象；无效 JSON 返回 undefined。 */
function parseMetadata(s: Skill): Record<string, unknown> | undefined {
  const raw = s.metadata_json;
  if (!raw || raw === "{}" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(s: Skill) {
  const metadata = parseMetadata(s);
  return {
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
    is_head: s.is_head,
    status: s.status,
    owner_user_id: s.user_id,
    owner_agent_id: s.owner_agent_id,
    team_id: s.team_id,
    task_id: s.task_id,
    created_at_ms: s.created_at_ms,
    updated_at_ms: s.updated_at_ms,
    ...(metadata ? { metadata } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Handlers
// ═════════════════════════════════════════════════════════════════════

export async function handleCreate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(createRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  // Quota check (like memory's checkMemoryQuota)
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.create(pre.data);
    try { trace.report("skill.create", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name }); } catch { /* noop */ }

    // ── 自动登记 skill 资产（asset_id === skill_id）+ 绑定到 owner agent 的 fixed-asset ──
    //
    // 为什么要在这里做：
    //   - standalone 模式下 SkillCore 由 TdaiCore 全局构造（无 onSkillCreated 钩子）；
    //   - 若不在这里补登记，asset/list-accessible / acl/* 等元数据层接口就查不到这个 skill，
    //     前端管控页的"团队资产 / 授权"链路完全断开。
    //
    // 与 service 模式的关系：
    //   - service 模式下 gateway 用 buildSkillCore 构造 per-instance SkillCore 时挂了同名钩子，
    //     两条路径都调 `metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name })`，
    //     该方法在 metadata-service.ts 内已实现幂等（LRU + 主键去重），重复调用无副作用。
    //
    // 失败策略：
    //   - 抛出异常 → create 请求整体返回错误。避免出现"skill 落库但 asset 缺失"
    //     的静默不一致状态（用户会疑惑"我创建成功了但看不到"）。
    //   - 与 v2-router.ts handleConversationAdd 里 ensureChatMemoryAsset 的做法一致。
    if (deps.getMetadataService && r.team_id && r.owner_agent_id) {
      try {
        const metaSvc = await deps.getMetadataService(auth.serviceId);
        await metaSvc.ensureSkillAsset({
          skill_id: r.skill_id,
          team_id: r.team_id,
          agent_id: r.owner_agent_id,
          name: r.name,
        });
      } catch (err) {
        deps.logger.error(
          `${TAG} ensureSkillAsset failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: r.skill_id, phase: "ensureSkillAsset" }, err instanceof Error ? err : undefined);
        return mapCoreError(err, requestId, deps, { skill_id: r.skill_id });
      }
    }

    obsLogger.info("skill.handleCreate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) { obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleUpdate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(updateRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.update(pre.data);
    try { trace.report("skill.update", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handleUpdate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleUpdate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handlePatch(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(patchRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.patch(pre.data);
    try { trace.report("skill.patch", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handlePatch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handlePatch.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(deleteRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleDelete.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.delete(pre.data);

    // ── asset 物理删除兜底：DELETE meta_assets + 级联清 agent 绑定 / ACL ──
    //
    // 为什么在这里再做一次：
    //   - service 模式：buildSkillCore 里的 onSkillArchived 钩子已经调过一次；这里再
    //     调是幂等收敛（deleteAssets 对已不存在的 asset 视为成功，无副作用）。
    //   - standalone 模式：SkillCore 由 TdaiCore 全局构造，未注入钩子（避免耦合
    //     MetadataService 拉起时序）。handler 层这一次调用是唯一联动入口。
    //
    // 失败策略：fire-and-forget，warn 不回退 delete。二次 delete 会重触发 core 钩子
    // 与本次兜底，最终收敛。参考 handleCreate 里 ensureSkillAsset 的对称做法
    // （只是失败策略相反：create 严格失败，delete 宽松以保证 skill 侧一定成功）。
    let assetSynced = false;
    if (r.archived && deps.getMetadataService && pre.data.team_id) {
      try {
        const metaSvc = await deps.getMetadataService(_auth.serviceId);
        await metaSvc.deleteAssets([r.skill_id]);
        assetSynced = true;
      } catch (err) {
        deps.logger.warn(
          `${TAG} [skill-asset-sync] deleteAssets(archive) failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      trace.report("skill.delete", {
        skill_id: r.skill_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        asset_synced: assetSynced,
      });
    } catch { /* noop */ }
    obsLogger.info("skill.handleDelete.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, archived: r.archived, asset_synced: assetSynced });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleDelete.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

/**
 * `POST /v3/skill/get-by-name` —— (team_id, agent_id, skill_name) → skill 详情。
 *
 * 见 skill-schemas.ts 里 `getByNameRequestSchema` 的动机注释。实现路径:
 *   1) schema 已强制 team_id + agent_id + skill_name 必填
 *   2) 走 `SkillCore.list` 拿到 (team, agent, name_prefix=name) 的候选(1-2 条)
 *   3) 精确名字匹配一条,交给 `SkillCore.get(skill_id)` 复用 include_content /
 *      include_manifest / version 分支,保证与 /v3/skill/get 输出体一致
 *
 * 找不到 → 40401 SKILL_NOT_FOUND(与 get 对齐,agent 视角看不出"是没这名字
 * 还是没这 id",统一一种错误码)。
 */
export async function handleGetByName(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getByNameRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGetByName.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // 用 name 当 prefix 拉 1-2 条候选(prefix LIKE 会命中同前缀的邻居,
    // 显式再 exact-match 一次;不用 limit=1 以便 exact 命中稳定)。
    const listed = await pre.core.list({
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      filters: { name_prefix: pre.data.skill_name },
      pagination: { limit: 10 },
    });
    const hit = listed.items.find((s) => s.name === pre.data.skill_name);
    if (!hit) {
      obsLogger.info("skill.handleGetByName.done", {
        req_id: requestId, code: 40401, dur_ms: Date.now() - t0,
        team_id: pre.data.team_id, agent_id: pre.data.agent_id, skill_name: pre.data.skill_name,
        reason: "not_found",
      });
      // 与 handleGet SKILL_NOT_FOUND 走同一路径:errorEnvelope(40401, ...)
      return errorEnvelope(40401, `SKILL_NOT_FOUND: no skill named "${pre.data.skill_name}" for agent ${pre.data.agent_id}`, requestId);
    }

    // 复用 handleGet 主体:构造 get input 走 core.get,保证行为完全一致
    // (含 version 分支、include_content / include_manifest 语义)。
    const row = await pre.core.get({
      user_id: pre.data.user_id,
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      task_id: pre.data.task_id,
      skill_id: hit.skill_id,
      version: pre.data.version,
      include_content: pre.data.include_content,
      include_manifest: pre.data.include_manifest,
    });
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGetByName.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: row.skill_id, version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0,
    });
    return successEnvelope(data, requestId);
  } catch (e) {
    obsLogger.error("skill.handleGetByName.done", {
      req_id: requestId, dur_ms: Date.now() - t0,
      skill_name: pre.data.skill_name,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGet.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const row = await pre.core.get(pre.data);
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    // Detail view 额外附上 content_hash / storage_dir（summary 没输出这些）。
    // 参考 docs/design/2026-06-17-skill-redesign-v2.md §3.4 SkillDetail 字段。
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGet.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: row.skill_id,
      version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0, });
    return successEnvelope(data, requestId);
  } catch (e) { obsLogger.error("skill.handleGet.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleList.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // 归档语义说明：`filters.status` 允许显式传 `['archived']` / `['active','archived']`，
    // 仅供管控台"回收站"视图使用。不传 status 时默认只返回 active（见
    // SqliteSkillStore.listSkills / TcvdbSkillStore.listSkills 中的默认值）。
    // 普通业务调用方 **不应** 显式请求 archived——它对读/写 API 已经不可见。
    const r = await pre.core.list(pre.data);
    obsLogger.info("skill.handleList.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: r.items.length, total: r.total });
    return successEnvelope({ items: r.items.map(toSummary), total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleList.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleSearch(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(searchRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleSearch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // scope="team" → strip agent_id so store does team-wide search (no owner filter).
    // The v3 isolation middleware already verified team_id + agent_id + user_id are present.
    const { scope, ...data } = pre.data;
    const searchInput = scope === "team"
      ? { ...data, agent_id: undefined }
      : data;
    const hits = await pre.core.search(searchInput);
    const items = hits.map((h) => ({
      ...toSummary(h.skill),
      score: h.score,
      // FTS5 snippet 可能为空（content 太短）；fallback 到 description。
      snippet: h.snippet && h.snippet.length > 0 ? h.snippet : h.skill.description,
    }));
    obsLogger.info("skill.handleSearch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: items.length, scope: pre.data.scope ?? "agent" });
    return successEnvelope({ items }, requestId);
  } catch (e) { obsLogger.error("skill.handleSearch.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleVersions(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(versionsRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.listVersions(pre.data);
    if (r.total === 0) {
      obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: 40401, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, reason: "not_found" });
      return errorEnvelope(40401, "skill not found", requestId);
    }
    const items = r.items.map((s) => ({
      ...toSummary(s),
      is_expired: (s as Skill & { is_expired: boolean }).is_expired ?? false,
    }));
    obsLogger.info("skill.handleVersions.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, items: items.length, total: r.total });
    return successEnvelope({ items, total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleVersions.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleFilesWrite(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesWriteRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.writeFiles(pre.data);
    obsLogger.info("skill.handleFilesWrite.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, files: pre.data.files.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesWrite.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRemove(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesRemoveRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.removeFiles(pre.data);
    obsLogger.info("skill.handleFilesRemove.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, paths: pre.data.paths.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesRemove.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(filesReadRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRead.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.readFile(pre.data);
    obsLogger.info("skill.handleFilesRead.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
      version: r.version,
      size_bytes: r.size_bytes,
      encoding: r.encoding, });
    return successEnvelope(r, requestId);
  } catch (e) { obsLogger.error("skill.handleFilesRead.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleExport(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(exportRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) {
    obsLogger.warn("skill.handleExport.done", {
      req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck",
    });
    return pre.envelope;
  }
  try {
    const r = await pre.core.exportSkill(pre.data);
    obsLogger.info("skill.handleExport.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: pre.data.skill_id, version: r.version,
      file_count: r.file_count, total_bytes: r.total_bytes,
    });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleExport.done", {
      req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

/**
 * `handleListing` 的 `mode='activity'` 分支实现 —— default-task 活跃度召回。
 *
 * 流程 (3 段式, 设计: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md):
 *   1. CH 查 skill_usage_logs 拿近 30 天 view/search 计数 + 最近活跃时间 top 60
 *      (`WINDOW_DAYS × CANDIDATE_MULTIPLIER × top_k` 的超集, 保证 version 强
 *       信号能翻盘挤进最终 top_k)
 *   2. 批量拿这些 skill 的 head (name/description/version/updated_at_ms)
 *   3. 4 维等权 MRR 打分 → 按 score DESC 取 top_k
 *
 * **绝不 throw**: 返回 null 表示"降级信号"(CH 不可用 / 查询失败 / 缺少必要 dep),
 * 由 handleListing 落到 auto 分支。空数组表示"数据窗内 0 活跃 skill"(冷启动),
 * 同样由 handleListing 落到 auto 分支。
 *
 * @returns
 *   - `null`: 无法执行(不可用/异常); 语义 = "请走 fallback"
 *   - `[]`  : 执行了但数据窗内无活跃 skill; 语义 = "请走 fallback (冷启动)"
 *   - `Item[]`: 有 N 个活跃 skill (最多 top_k 个)
 */
async function resolveActivityHits(args: {
  deps: SkillRouterDeps;
  core: SkillCore;
  team_id: string;
  agent_id: string;
  top_k: number;
}): Promise<Array<{ skill_id: string; name: string; description: string; version: number }> | null> {
  const { deps, core, team_id, agent_id, top_k } = args;

  // 无 CH client dep → 未装配, 直接降级 (向后兼容: 老 deployment 完全不受影响)
  if (!deps.getAnalyticsChClient) return null;

  const ch = await deps.getAnalyticsChClient().catch(() => null);
  if (!ch) return null;                              // CH 未配置

  const WINDOW_DAYS = 30;
  const CANDIDATE_MULTIPLIER = 3;                    // 超集: 20 * 3 = 60
  const candidateK = Math.max(top_k, top_k * CANDIDATE_MULTIPLIER);

  // Step 1: CH 查 view/search count + last_active_ts
  type ActivityRow = {
    skill_id: string;
    view_cnt: string | number;
    search_cnt: string | number;
    last_active_ts: string;             // CH DateTime64 → ISO string in JSONEachRow
  };
  let candidates: ActivityRow[];
  try {
    candidates = await ch.query<ActivityRow>({
      query: `
        SELECT
          skill_id,
          countIf(event_type = 'view')       AS view_cnt,
          countIf(event_type = 'search_hit') AS search_cnt,
          max(timestamp)                     AS last_active_ts
        FROM skill_usage_logs
        WHERE team_id = {team_id:String}
          AND agent_id = {agent_id:String}
          AND timestamp >= now() - INTERVAL {window_days:UInt16} DAY
        GROUP BY skill_id
        ORDER BY view_cnt DESC, search_cnt DESC, last_active_ts DESC
        LIMIT {candidate_k:UInt16}
      `,
      query_params: {
        team_id,
        agent_id,
        window_days: WINDOW_DAYS,
        candidate_k: candidateK,
      },
    });
  } catch (err) {
    deps.logger.warn?.(`${TAG} activity: CH query failed`, err instanceof Error ? err.message : String(err));
    return null;                                     // CH 查询挂 → 降级
  }
  if (!candidates || candidates.length === 0) return [];   // 冷启动 → 降级

  // Step 2: 批量 getHead 拿 name/description/version/updated_at_ms
  // 不用 SkillCore.get (它有权限校验+审计, 不适合批查); 直接过 store。
  // 内部错误吞掉不 throw, 单个 skill 失败不影响其他。
  type Enriched = {
    skill_id: string;
    name: string;
    description: string;
    version: number;
    view_cnt: number;                 // 从 candidates 透传, 强制 Number() 防 CH JSONEachRow string
    search_cnt: number;               // 同上
    version_cnt: number;              // 版本数近似 = head.version (每次 patch/update 递增)
    last_active: number;              // max(events last_active, head.updated_at_ms)
  };
  const enriched: Enriched[] = [];
  await Promise.all(candidates.map(async (c) => {
    try {
      const head = await core.get({ skill_id: c.skill_id, team_id });
      const eventTs = Date.parse(String(c.last_active_ts));    // ISO → ms; 失败为 NaN
      const eventTsSafe = Number.isFinite(eventTs) ? eventTs : 0;
      // CH JSONEachRow 对 UInt64 count 默认返回 string (output_format_json_quote_64bit_integers=1);
      // 不强转直接给 rankBy 用 → keyFn 拿到 undefined 或 string 都会让排序坏掉。
      // Number(undefined) = NaN, Number("16") = 16, 都是安全的兜底。
      const viewCnt = Number(c.view_cnt) || 0;
      const searchCnt = Number(c.search_cnt) || 0;
      enriched.push({
        skill_id: head.skill_id,
        name: head.name,
        description: head.description,
        version: head.version,
        view_cnt: viewCnt,
        search_cnt: searchCnt,
        version_cnt: head.version,                              // = countVersions 的近似
        last_active: Math.max(eventTsSafe, head.updated_at_ms),
      });
    } catch {
      // skill 可能已删/无权访问 → 跳过, 不影响其他候选
    }
  }));
  if (enriched.length === 0) return [];

  // Step 3: 4 维 MRR 打分 + top_k slice
  // 权重先都相等 (0.25), 上线看 dashboard 数据后调
  const W = { view: 0.25, search: 0.25, recency: 0.25, version: 0.25 };

  // 竞赛式排名 (同分同名次, 下一名跳过); tiebreaker: last_active DESC
  function rankBy<K>(list: Enriched[], keyFn: (s: Enriched) => number): Map<string, number> {
    const sorted = [...list].sort((a, b) => {
      const dk = keyFn(b) - keyFn(a);
      if (dk !== 0) return dk;
      return b.last_active - a.last_active;
    });
    const ranks = new Map<string, number>();
    let currentRank = 0;
    let lastKey: number | null = null;
    for (let i = 0; i < sorted.length; i++) {
      const key = keyFn(sorted[i]);
      if (lastKey === null || key !== lastKey) {
        currentRank = i + 1;
        lastKey = key;
      }
      ranks.set(sorted[i].skill_id, currentRank);
    }
    return ranks;
  }

  const rView    = rankBy(enriched, (s) => s.view_cnt);
  const rSearch  = rankBy(enriched, (s) => s.search_cnt);
  const rRecency = rankBy(enriched, (s) => s.last_active);
  const rVersion = rankBy(enriched, (s) => s.version_cnt);

  const scored = enriched.map((s) => ({
    ...s,
    score:
        W.view    * (1 / (rView.get(s.skill_id)    ?? enriched.length))
      + W.search  * (1 / (rSearch.get(s.skill_id)  ?? enriched.length))
      + W.recency * (1 / (rRecency.get(s.skill_id) ?? enriched.length))
      + W.version * (1 / (rVersion.get(s.skill_id) ?? enriched.length)),
  }));

  // 同分 tiebreaker: skill_id ASC —— enriched 由 Promise.all + push 组装,
  // 天然顺序不稳定; 没有 tiebreaker 会让"view=4 search=6" 和 "view=3 search=6
  // last_active_newer" 这种严格 MRR 相等的 skill 每次返回顺序不同。
  // 按 skill_id 字典序做兜底保证幂等。
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill_id < b.skill_id ? -1 : (a.skill_id > b.skill_id ? 1 : 0);
  });

  return scored.slice(0, top_k).map((s) => ({
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
  }));
}

export async function handleListing(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listingRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleListing.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const charBudget = pre.data.char_budget ?? 8000;
    const query = (pre.data.query ?? "").trim();
    const useSearch = query.length > 0;

    // 从配置读 routing：searchTopK（listing 最多注入多少条）+ mode（bm25/embedding/hybrid）。
    const routing = deps.getResolvedSkillConfig?.()?.routing;
    const topK = routing?.searchTopK ?? 20;

    type Item = { skill_id: string; name: string; description: string; version: number };
    let items: Item[] = [];
    let mode: "full" | "search" | "activity" = "full";

    // 活跃度召回优先路径 (仅当调用方显式指定 mode='activity')。
    // 任何环节失败/空 → 落到下面的老逻辑, 主链路无感知。
    // 设计: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
    const wantActivity = pre.data.mode === "activity";
    let activityAttempted = false;
    let activityFallbackReason: string | undefined;
    if (wantActivity) {
      activityAttempted = true;
      try {
        const activityItems = await resolveActivityHits({
          deps,
          core: pre.core,
          team_id: pre.data.team_id!,
          agent_id: pre.data.agent_id!,
          top_k: topK,
        });
        if (activityItems && activityItems.length > 0) {
          items = activityItems;
          mode = "activity";
        } else {
          activityFallbackReason = activityItems === null ? "unavailable" : "empty";
        }
      } catch (err) {
        // resolveActivityHits 内部已经吞了大部分异常, 到这里说明极端情况。
        activityFallbackReason = "exception";
        deps.logger.warn?.(
          `${TAG} activity recall failed, falling back to auto`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 老 auto 逻辑 —— 未走 activity 或 activity 空/失败 时走此路径。
    // search 模式：按 routing.mode 选检索算法；fallback 到 list head（query 为空）。
    if (mode !== "activity") {
      if (useSearch) {
        const hits = await pre.core.search({
          user_id: pre.data.user_id,
          team_id: pre.data.team_id,
          agent_id: pre.data.agent_id,
          query,
          top_k: topK,
          mode: routing?.mode,
        });
        items = hits.map((h) => ({
          skill_id: h.skill.skill_id,
          name: h.skill.name,
          description: h.skill.description,
          version: h.skill.version,
        }));
        mode = "search";
      } else {
        const r = await pre.core.list({
          user_id: pre.data.user_id,
          team_id: pre.data.team_id,
          agent_id: pre.data.agent_id,
          pagination: { limit: topK },
        });
        items = r.items.map((s) => ({
          skill_id: s.skill_id,
          name: s.name,
          description: s.description,
          version: s.version,
        }));
        mode = items.length < topK ? "full" : "search";
      }
    }

    // 渲染 listing；按 char_budget 截断（保留头部 + 显式截断标记）。
    // 默认 id 模式: 每行结构化 `- id=<skill_id>, name=<name>, desc=<description>`,
    //   并在块内顶部加一行格式说明,让 agent 明确知道哪个字段是 skill_id、调 skill_view 时用它。
    // SKILL_VIEW_MODE=name 时回退旧格式 `- name: description`(不暴露 id)。
    // 见 skill_eval v9(name) vs v10(id) 对比实验。
    const exposeSkillId = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() !== "name";
    // description 里的换行会破坏"每行一个 skill"的结构,折成空格。
    const flat = (s: string) => (s ?? "").replace(/\s*\n\s*/g, " ").trim();
    const lines = items.map((s) =>
      exposeSkillId
        ? `- id=${s.skill_id}, name=${s.name}, desc=${flat(s.description)}`
        : `- ${s.name}: ${s.description}`,
    );
    const formatHint = exposeSkillId
      ? "# 每行一个 skill,字段以逗号分隔: id=<skill_id>, name=<名字>, desc=<描述>。\n" +
        "# 调用 skill_view 时传 id 字段的值(形如 skl-xxxxxx)。\n"
      : "";
    let listing = lines.length === 0
      ? "<available_skills>\n(none)\n</available_skills>"
      : `<available_skills>\n${formatHint}${lines.join("\n")}\n</available_skills>`;

    if (listing.length > charBudget) {
      const truncated = listing.slice(0, Math.max(0, charBudget - 32));
      listing = `${truncated}\n... [truncated]\n</available_skills>`;
    }

    obsLogger.info("skill.handleListing.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, mode,
      hits: items.length,
      listing_len: listing.length,
      truncated: listing.length >= charBudget,
      activity_attempted: activityAttempted,
      activity_fallback_reason: activityFallbackReason, });
    return successEnvelope({
      mode,
      listing,
      hits: items.map((s) => ({ skill_id: s.skill_id, version: s.version, name: s.name })),
    }, requestId);
  } catch (e) { obsLogger.error("skill.handleListing.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

/**
 * `POST /v3/skill/extract` — direct-trigger 归档一次会话切片。
 *
 * 改造前是"入 Redis job 队列 + 轮询 /result"; 改造后走跟 conversation/add
 * 完全同一套下游 (`SkillTriggerService.archive()` → agent 队列 → 复用
 * `SkillConversationExtractWorker`)，只是不写 data-current/meta，一次调用
 * 产生一个独立 archive + 一条 SkillTaskEntry。
 *
 * 详见 `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md`。
 */
export async function handleExtract(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  // [obs] handler 内部分段走 obsLogger：每段一次 info 事件，字段结构化
  // (req_id / dur_ms / …)，一路都能按 req_id 关联；obsLogger 内部 try/catch，
  // logger 后端挂了也不影响业务。
  const t0 = Date.now();

  const t0Parse = Date.now();
  const parsed = extractRequestSchema.safeParse(body);
  obsLogger.info("skill.handleExtract.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill extract not wired (resolveConversationAdd missing)", requestId);
  }
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleExtract.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill extract not wired for this instance", requestId);
  }

  // direct-trigger 恒生成一次性 session id (前缀 sx-) —— 因为它没有跨轮 buffer,
  // session_id 只决定 COS 归档路径分段, 每次调用独立即可; caller 传了也接受。
  const sessionId = input.session_id ?? `sx-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // 压缩 + 兜底策略 (2026-08-10 重新设计):
  //   ① 总量 < chunkMax → 全量归档, 不压不截
  //   ② 总量 ≥ chunkMax → 压缩 tool 消息 (> threshold 的 tool_call/tool_result 截头尾)
  //   ③ 压缩后仍 ≥ chunkMax → 走 oversize 兜底截断 (保留头 + 尾, 中间砍掉)
  // 从 resolvedSkillConfig 取参数; DEFAULT_* 仅作 fallback (standalone 未配置场景)。
  const skillCfg = deps.getResolvedSkillConfig?.();
  const compressOpts = skillCfg
    ? {
        toolContentThresholdBytes: skillCfg.compress.toolContentThresholdBytes,
        headBytes: skillCfg.compress.headBytes,
        tailBytes: skillCfg.compress.tailBytes,
      }
    : DEFAULT_COMPRESS_OPTIONS;
  const oversizeOpts = skillCfg
    ? {
        chunkMaxBytes: skillCfg.extraction.chunkMaxBytes,
        headKeepBytes: skillCfg.extraction.headKeepBytes,
        tailKeepBytes: skillCfg.extraction.tailKeepBytes,
      }
    : DEFAULT_OVERSIZE_OPTIONS;
  const chunkMax = oversizeOpts.chunkMaxBytes ?? DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes;

  const t0Prep = Date.now();
  const incoming: CompressibleMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_call_id: m.tool_call_id,
  }));

  // 先算原始字节, 只有超过 chunkMax 时才走压缩 + 兜底
  const rawBytes = incoming.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m), "utf8"), 0,
  );
  const needCompress = rawBytes >= chunkMax;

  const prepared = prepareArchivePayload(
    /* existing */ [],
    incoming,
    {
      compress: compressOpts,
      oversize: oversizeOpts,
      forceCompress: needCompress,
    },
  );
  obsLogger.info("skill.handleExtract.prepare_archive", {
    req_id: requestId, dur_ms: Date.now() - t0Prep,
    msg_in: input.messages.length, msg_out: prepared.messages.length,
    raw_bytes: rawBytes, need_compress: needCompress,
    used_compress: prepared.usedCompress, used_oversize: prepared.usedOversize,
  });

  // space_id 优先取 body（向后兼容早期调用方），缺省回落到 auth.serviceId ——
  // 两个值在设计上就该相等（都是"当前登录实例"）。不等则记一条告警, 帮助早发现
  // 调用方传错实例的 bug；隔离/鉴权/路由都靠 auth.serviceId 做，跟 body 无关。
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/extract space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Archive = Date.now();
    const res = await wired.trigger.archive({
      session: {
        // 2026-07-30 instance_id 塞进 tuple; worker pool 从队列出来后按此路由
        // 到对应 instance 的资源 (CoS bucket / VDB collection / LLM key)。
        instance_id: auth.serviceId,
        space_id: spaceId,
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
      },
      bufferAtTrigger: { messages: prepared.messages as Array<Record<string, unknown>> },
      taskRefId: input.task_id,
      reason: input.reason,
      maxIterations: input.options?.max_iterations,
      // strict_mode:true 时落 SkillTaskEntry.mode='strict', Worker 消费时透传给
      // SkillExtractor 用 STRICT prompt。老 client 不传 → 恒走 default (v2 宽松)。
      ...(input.strict_mode === true ? { mode: 'strict' as const } : {}),
      // 透传 requestId 给 trigger 内部分段 obsLogger 事件用作 anchor
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleExtract.trigger_archive", {
      req_id: requestId, dur_ms: Date.now() - t0Archive,
      task_id: res.taskId, archive_key: res.archiveKey,
    });

    try {
      metricProducer.send({ metric: "skill.extract.request", instanceId: input.team_id, value: 1 });
    } catch { /* noop */ }

    // trace.report 后端 span：跟 create/update/patch/delete 对齐；task_id 是 anchor，
    // clickhouse / langfuse 里按 task_id 就能拉到 worker 侧 skill.worker.task_done。
    try {
      trace.report("skill.extract", {
        task_id: res.taskId,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
        msg_count: prepared.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleExtract.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, task_id: res.taskId, msg_count: prepared.messages.length, });
    return successEnvelope({
      ok: true,
      task_id: res.taskId,
      archived_at_ms: res.archivedAtMs,
      archive_key: res.archiveKey,
    }, requestId);
  } catch (e) {
    deps.logger.warn(`${TAG} /v3/skill/extract archive failed: ${(e as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleExtract.done", { req_id: requestId, dur_ms: Date.now() - t0, reason: "archive_failed" }, e instanceof Error ? e : undefined);
    return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /v3/skill/conversation/add  —  新链路: 每轮对话增量入口
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /v3/skill/conversation/add`
 *
 * Client (proxy) 每轮对话结束后同步调用一次。Handler 内部完成
 * 拼接 + 阈值判定 + 归档段（先登记后落 archive）。返回 { status, archived? }.
 *
 * 参考 `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1。
 */
export async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  // [obs] proxy 每轮结束都会打，是最高频的 skill 接口。分段事件：
  //   skill.handleConversationAdd.schema_parse / resolve_wired / handler_handle / done
  // handler.handle 内部还会分 read_buffer / prepare_archive / trigger.archive /
  // write_back 四段（由 SkillConversationAddHandler 内部走 obsLogger，跟 trigger
  // 复用同一 req_id 关联）。
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(404, "Skill conversation-add module not enabled", requestId);
  }
  const t0Parse = Date.now();
  const parsed = conversationAddRequestSchema.safeParse(body);
  obsLogger.info("skill.handleConversationAdd.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  // service 模式下用 auth.serviceId 解析租户级 wired; standalone 忽略 serviceId
  // 由 wiring 返回单例。
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleConversationAdd.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(404, "Skill conversation-add module not enabled for this instance", requestId);
  }

  // space_id 优先取 body, 缺省回落到 auth.serviceId (跟 handleExtract 同一处理).
  // 两个值在设计上就该相等；不等则告警。
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/conversation/add space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Handle = Date.now();
    const out = await wired.handler.handle({
      // 2026-07-30 instance_id 塞进 tuple; worker pool 从队列出来后按此路由。
      instance_id: auth.serviceId,
      session_id: input.session_id,
      space_id: spaceId,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      // schema 保证 role 合法, tool_name/tool_call_id 由 handler 内校验
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      })),
      // strict_mode:true 时归档段落 SkillTaskEntry.mode='strict', Worker 消费时用
      // STRICT prompt (SKILL_REVIEW_PROMPT_STRICT)。老 client 不传即走 default。
      ...(input.strict_mode === true ? { mode: 'strict' as const } : {}),
      // 透传 requestId 给 handler 内部分段 obsLogger 用；trigger.archive 也会再透传一层
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleConversationAdd.handler_handle", {
      req_id: requestId, dur_ms: Date.now() - t0Handle,
      status: out.status, reason: out.archived?.reason,
    });

    try {
      trace.report("skill.conversation_add", {
        session_id: input.session_id,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        status: out.status,
        archived_task_id: out.archived?.task_id,
        reason: out.archived?.reason,
        msg_count: input.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleConversationAdd.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: out.status,
      reason: out.archived?.reason,
      task_id: out.archived?.task_id,
      msg_count: input.messages.length, });
    return successEnvelope(out, requestId);
  } catch (err) {
    // HandlerValidationError → 400；其他 → 500
    const isValidation = err instanceof Error && err.name === "HandlerValidationError";
    if (isValidation) {
      obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0, field: (err as { field?: string }).field }, err instanceof Error ? err : undefined);
      return errorEnvelope(40001, err.message, requestId);
    }
    deps.logger.warn(`${TAG} /v3/skill/conversation/add failed: ${(err as Error).message}`);
    obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  POST /v3/skill/conversation/force-archive
//  手动强制归档当前 session buffer（第三个触发条件：跳过阈值）
// ═════════════════════════════════════════════════════════════════════

export async function handleForceArchive(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill force-archive not wired (resolveConversationAdd missing)", requestId);
  }

  const parsed = forceArchiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  const wired = await deps.resolveConversationAdd(auth.serviceId);
  if (!wired) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill force-archive not wired for this instance", requestId);
  }

  const sess = {
    // 2026-08-04 修复: 缺 instance_id 会让 trigger.archive → serializeAgentTuple
    // 抛 `instance_id must be a non-empty string`, handler 把它包成 envelope
    // 50001 返给 proxy, 面板 / mem:create-skill "强制归档" 100% 失败。
    // 跟 handleExtract / handleConversationAdd 保持一致, 从 auth.serviceId 兜底。
    instance_id: auth.serviceId,
    space_id: input.space_id,
    user_id: input.user_id,
    team_id: input.team_id,
    agent_id: input.agent_id,
    session_id: input.session_id,
  };

  try {
    // 读取当前 buffer
    const [current, meta] = await Promise.all([
      wired.buffer.readCurrent(sess),
      wired.buffer.readMeta(sess),
    ]);

    // Buffer 为空：无需归档
    if (!current.messages || current.messages.length === 0) {
      obsLogger.info("skill.handleForceArchive.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: "empty" });
      return successEnvelope({ status: "empty", message: "No messages in buffer to archive" }, requestId);
    }

    // 无条件调 trigger.archive（跳过阈值判断）
    const archiveRes = await wired.trigger.archive({
      session: sess,
      bufferAtTrigger: { messages: current.messages },
      taskRefId: input.task_id,
      reason: input.reason,
      perfRequestId: requestId,
    });

    // 归档后清空 buffer + 重置 meta（与 add-handler 归档后行为一致）
    const nowMs = Date.now();
    await Promise.all([
      wired.buffer.writeCurrent(sess, { messages: [] }),
      wired.buffer.writeMeta(sess, {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      }),
    ]);

    obsLogger.info("skill.handleForceArchive.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      status: "archived", task_id: archiveRes.taskId,
    });
    return successEnvelope({
      status: "archived",
      task_id: archiveRes.taskId,
      archived_at_ms: archiveRes.archivedAtMs,
      archive_key: archiveRes.archiveKey,
    }, requestId);
  } catch (err) {
    deps.logger.warn(`${TAG} /v3/skill/conversation/force-archive failed: ${(err as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleForceArchive.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════════════

export type SkillHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
) => Promise<ApiResponseEnvelope>;

export function makeSkillRouteTable(): Record<string, SkillHandler> {
  return {
    "/v3/skill/create": handleCreate,
    "/v3/skill/update": handleUpdate,
    "/v3/skill/patch": handlePatch,
    "/v3/skill/delete": handleDelete,
    "/v3/skill/get": handleGet,
    "/v3/skill/get-by-name": handleGetByName,
    "/v3/skill/list": handleList,
    "/v3/skill/search": handleSearch,
    "/v3/skill/versions": handleVersions,
    "/v3/skill/files/write": handleFilesWrite,
    "/v3/skill/files/remove": handleFilesRemove,
    "/v3/skill/files/read": handleFilesRead,
    "/v3/skill/export": handleExport,
    "/v3/skill/listing": handleListing,
    "/v3/skill/extract": handleExtract,
    "/v3/skill/conversation/add": handleConversationAdd,
    "/v3/skill/conversation/force-archive": handleForceArchive,
  };
}

/** Public skill routes, exported for capability-registry coverage checks. */
export const SKILL_PUBLIC_ROUTES = Object.freeze(
  Object.keys(makeSkillRouteTable()),
);
