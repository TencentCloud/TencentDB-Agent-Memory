/**
 * TDAI Memory Gateway — v2 REST Router.
 *
 * Implements POST routes defined in `01-api-spec.yaml`:
 *
 *   L0 Conversation: add / query / search / delete
 *   L1 Atomic:       update / query / search / delete
 *   L2 Scenario:     ls / read / write / rm
 *   L3 Core:         read / write
 *
 * All routes are prefixed with `/v2/`.
 * Authentication: Authorization Bearer + x-tdai-service-id.
 * Request validation: Zod v4 safeParse → 400 on failure.
 * Response envelope: { code, message, request_id, data }.
 */

import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import { classifyError } from "./error-handler.js";
import type { IMemoryStore, L0Record, ProfileSyncRecord } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";
import { clampSceneSummary } from "../core/scene/scene-summary.js";
import type { Logger } from "../core/types.js";
import type { IStateBackend } from "../core/state/types.js";
import type { PipelineWorker } from "../services/pipeline-worker.js";
import { executeMemorySearch } from "../core/tools/memory-search.js";
import { executeConversationSearch } from "../core/tools/conversation-search.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import { reportRecallMetrics } from "../core/report/metric-tracking-recall.js";

// ── Zod schemas (validated types + defaults) ──
import {
  conversationAddRequestSchema,
  conversationQueryRequestSchema,
  conversationSearchRequestSchema,
  conversationDeleteRequestSchema,
  atomicUpdateRequestSchema,
  atomicQueryRequestSchema,
  atomicSearchRequestSchema,
  atomicDeleteRequestSchema,
  scenarioListRequestSchema,
  scenarioReadRequestSchema,
  scenarioWriteRequestSchema,
  scenarioRmRequestSchema,
  coreWriteRequestSchema,
  formatZodError,
  type ApiResponseEnvelope,
  type V2AuthContext,
  type ConversationItem,
  type ConversationSearchHit,
  type ConversationAddData,
  type ConversationQueryData,
  type ConversationSearchData,
  type ConversationDeleteData,
  type AtomicDetail,
  type AtomicUpdateData,
  type AtomicQueryData,
  type AtomicSearchData,
  type AtomicSearchHit,
  type AtomicDeleteData,
  type ScenarioListData,
  type ScenarioEntry,
  type ScenarioFile,
  type ScenarioWriteData,
  type CoreFile,
  type CoreWriteData,
} from "./v2-schemas.js";
import { clampSceneNavigationSummaries, stripSceneNavigation } from "../core/scene/scene-navigation.js";

const TAG = "[tdai-gateway][v2]";
const V2_PREFIX = "/v2";

// ============================
// Dependencies injected at mount time
// ============================

export interface V2RouterDeps {
  /** Get the default IMemoryStore (standalone fallback). */
  getStore: () => IMemoryStore | undefined;
  /** Get the default EmbeddingService (standalone fallback). */
  getEmbedding: () => EmbeddingService | undefined;
  /** Get the default StorageAdapter (standalone fallback). */
  getStorage: () => StorageAdapter | undefined;
  logger: Logger;

  /**
   * Deploy mode of the gateway. Controls behaviors that diverge between
   * single-node open-source ("standalone") and cloud multi-tenant ("service"):
   *   - standalone: mirror v2 conversation/add L0 to <dataDir>/conversations/<date>.jsonl
   *                 (parity with v1 capture path; useful for human inspection / seed verify)
   *   - service:    skip the JSONL mirror — service stores authoritative L0 in TCVDB +
   *                 COS via its own pathway; mirroring to local FS would write to
   *                 ephemeral pod disk and is operationally meaningless.
   */
  deployMode: "standalone" | "service";

  // ── Service-mode per-instance resolvers (optional) ──
  // When provided, v2 handlers resolve store/storage per-request using
  // auth.serviceId as the instanceId key, falling back to the static getters above.

  /** Resolve IMemoryStore + EmbeddingService for a given instanceId (service mode). */
  resolveStore?: (instanceId: string) => Promise<{ store: IMemoryStore; embedding: EmbeddingService | undefined }>;
  /** Resolve per-instance StorageAdapter for a given instanceId (service mode). */
  resolveStorage?: (instanceId: string) => Promise<StorageAdapter | undefined>;

  /**
   * Notify pipeline that new L0 messages were added for a session.
   * Triggers async L1 extraction via state-backend Buffer → Scanner → Worker.
   *
   * Wired in both modes:
   *   - service mode: remote state backend
   *   - standalone: LocalStateBackend (single-process, default)
   * When absent (misconfiguration), v2 add writes L0 only — pipeline is not triggered.
   */
  notifyPipeline?: (instanceId: string, sessionId: string, messageCount: number) => Promise<void>;

  /** Quota manager for memory/credit limit checks and usage reporting (service mode). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;

  /**
   * State backend handle, used by /v2/pipeline/status to call listQueuedTasks().
   * Wired in standalone and service modes, but the status endpoint itself is
   * standalone-only. The handler returns 404 in service mode before touching
   * this field, so remote backends do not need to implement listQueuedTasks().
   */
  stateBackend?: IStateBackend;

  /**
   * Pipeline worker handle, used by /v2/pipeline/status to call getRunningTasks()
   * for per-L-type in-flight stats. Service mode never invokes this getter
   * (status endpoint returns 404 in service mode).
   */
  pipelineWorker?: PipelineWorker;
}

// ============================
// Envelope helpers
// ============================

export function makeRequestId(): string {
  return `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function successEnvelope<T>(data: T, requestId: string): ApiResponseEnvelope<T> {
  return { code: 0, message: "ok", request_id: requestId, data };
}

export function errorEnvelope(code: number, message: string, requestId: string): ApiResponseEnvelope {
  return { code, message, request_id: requestId };
}

// ============================
// Auth middleware
// ============================

export function parseV2Auth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  sendJsonFn: (res: http.ServerResponse, status: number, body: unknown) => void,
): V2AuthContext | null {
  const authHeader = req.headers["authorization"] ?? "";
  const serviceId = (req.headers["x-tdai-service-id"] as string) ?? "";

  if (!authHeader.startsWith("Bearer ") || !authHeader.slice(7).trim()) {
    sendJsonFn(res, 401, errorEnvelope(401, "Missing or invalid Authorization header. Expected: Bearer {api_key}", requestId));
    return null;
  }
  if (!serviceId.trim()) {
    sendJsonFn(res, 401, errorEnvelope(401, "Missing x-tdai-service-id header", requestId));
    return null;
  }

  return { apiKey: authHeader.slice(7).trim(), serviceId: serviceId.trim() };
}

// ============================
// Per-request resolution helpers
// ============================

/** Resolve store + embedding for a v2 request. Service mode → per-instance; standalone → core singleton. */
async function resolveStoreForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<{ store: IMemoryStore | undefined; embedding: EmbeddingService | undefined }> {
  if (deps.resolveStore) {
    // Service mode: per-instance VDB store is mandatory. Do NOT fallback to local SQLite.
    return await deps.resolveStore(auth.serviceId);
  }
  // Standalone mode: use core singleton store
  return { store: deps.getStore(), embedding: deps.getEmbedding() };
}

/** Resolve storage adapter for a v2 request. Service mode → per-instance COS; standalone → core local. */
async function resolveStorageForRequest(
  auth: V2AuthContext,
  deps: V2RouterDeps,
): Promise<StorageAdapter | undefined> {
  if (deps.resolveStorage) {
    // Service mode: per-instance COS storage is mandatory. Do NOT fallback to local filesystem.
    return await deps.resolveStorage(auth.serviceId);
  }
  // Standalone mode: use core local storage
  return deps.getStorage();
}

// ============================
// Route table
// ============================

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
) => Promise<ApiResponseEnvelope>;

const routeTable: Record<string, RouteHandler> = {
  [`${V2_PREFIX}/conversation/add`]: handleConversationAdd,
  [`${V2_PREFIX}/conversation/query`]: handleConversationQuery,
  [`${V2_PREFIX}/conversation/search`]: handleConversationSearch,
  [`${V2_PREFIX}/conversation/delete`]: handleConversationDelete,
  [`${V2_PREFIX}/atomic/update`]: handleAtomicUpdate,
  [`${V2_PREFIX}/atomic/query`]: handleAtomicQuery,
  [`${V2_PREFIX}/atomic/search`]: handleAtomicSearch,
  [`${V2_PREFIX}/atomic/delete`]: handleAtomicDelete,
  [`${V2_PREFIX}/scenario/ls`]: handleScenarioLs,
  [`${V2_PREFIX}/scenario/read`]: handleScenarioRead,
  [`${V2_PREFIX}/scenario/write`]: handleScenarioWrite,
  [`${V2_PREFIX}/scenario/rm`]: handleScenarioRm,
  [`${V2_PREFIX}/core/read`]: handleCoreRead,
  [`${V2_PREFIX}/core/write`]: handleCoreWrite,
  [`${V2_PREFIX}/pipeline/status`]: handlePipelineStatus,
};

export async function handleV2Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V2RouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V2_PREFIX) || method !== "POST") return false;

  const handler = routeTable[pathname];
  if (!handler) return false;

  const requestId = makeRequestId();
  const auth = parseV2Auth(req, res, requestId, sendJson);
  if (!auth) return true;

  try {
    // Pre-resolve per-request store/storage (service mode → per-instance, standalone → core singleton)
    const resolved = await resolveStoreForRequest(auth, deps);
    const resolvedStorage = await resolveStorageForRequest(auth, deps);

    // Wrap deps so handlers use the resolved per-instance resources
    const resolvedDeps: V2RouterDeps = {
      ...deps,
      getStore: () => resolved.store,
      getEmbedding: () => resolved.embedding,
      getStorage: () => resolvedStorage,
    };

    const body = await parseJsonBody(req);
    const envelope = await handler(body, auth, requestId, resolvedDeps);
    const httpStatus = envelope.code === 0 ? 200 : envelope.code >= 400 && envelope.code < 600 ? envelope.code : 200;
    sendJson(res, httpStatus, envelope);
  } catch (err) {
    // H-13: use classifyError so 5xx leaves no err.message leak; PayloadTooLargeError
    // and RecallFailure already carry safe messages but go through the same path for uniformity.
    const classified = classifyError(err);
    if (classified.status >= 500) {
      deps.logger.error(`${TAG} [${pathname}] ${classified.logLine}`);
    } else {
      deps.logger.warn(`${TAG} [${pathname}] ${classified.logLine}`);
    }
    sendJson(res, classified.status, {
      ...errorEnvelope(classified.client.code, classified.client.message, requestId),
      trace_id: classified.client.trace_id,
      retryable: classified.client.retryable,
    });
  }

  return true;
}

// ============================
// L0 Conversation Handlers
// ============================

async function handleConversationAdd(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationAddRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, messages } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Quota check: memory limit
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, messages.length);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  const embedding = deps.getEmbedding();
  const acceptedIds: string[] = [];
  const ingestBaseMs = Date.now();

  for (const [index, msg] of messages.entries()) {
    const id = `msg-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const recordedAtMs = ingestBaseMs + index;
    const record: L0Record = {
      id,
      sessionKey: session_id,
      sessionId: session_id,
      role: msg.role,
      messageText: msg.content,
      recordedAt: new Date(recordedAtMs).toISOString(),
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : recordedAtMs,
    };

    let emb: Float32Array | undefined;
    if (embedding) {
      try { emb = await embedding.embed(msg.content); } catch { /* non-fatal */ }
    }

    await store.upsertL0(record, emb);
    acceptedIds.push(id);
  }

  // Notify pipeline: trigger async L1 extraction (service mode).
  // Each role=user message counts as one conversation round for threshold/timer logic.
  if (deps.notifyPipeline) {
    const rounds = messages.filter((m) => m.role === "user").length;
    if (rounds > 0) {
      try {
        await deps.notifyPipeline(auth.serviceId, session_id, rounds);
      } catch (err) {
        // Non-fatal: L0 is already persisted, pipeline will catch up later
        deps.logger.warn(`${TAG} Pipeline notify failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Standalone-only: mirror L0 to <dataDir>/conversations/<date>.jsonl.
  // Parity with v1 /capture (l0-recorder) path — gives humans a grep-able audit
  // log alongside SQLite. Service mode skips: COS is the authoritative store,
  // and writing to local FS in a multi-replica pod would be ephemeral + useless.
  // Failure is non-fatal: SQLite is the source of truth.
  if (deps.deployMode === "standalone") {
    const storage = deps.getStorage();
    if (storage) {
      try {
        const recordKey = StoragePaths.conversation(formatLocalDateForJsonl(new Date(ingestBaseMs)));
        const lines = messages.map((msg, idx) => JSON.stringify({
          id: acceptedIds[idx],
          sessionKey: session_id,
          sessionId: session_id,
          role: msg.role,
          content: msg.content,
          recordedAt: new Date(ingestBaseMs + idx).toISOString(),
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : ingestBaseMs + idx,
        })).join("\n") + "\n";
        await storage.appendFile(recordKey, lines);
      } catch (err) {
        deps.logger.warn(`${TAG} JSONL mirror failed for ${session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Report memory usage (non-fatal)
  if (deps.quotaManager && acceptedIds.length > 0) {
    deps.quotaManager.reportMemoryAdded(auth.serviceId, acceptedIds.length).catch(() => {});
  }

  return successEnvelope<ConversationAddData>(
    { accepted_ids: acceptedIds, total_count: acceptedIds.length },
    requestId,
  );
}

async function handleConversationQuery(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationQueryRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { session_id, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Use paginated query if available (AR-3), else fallback
  if (store.queryL0Paginated) {
    const result = await store.queryL0Paginated({
      sessionId: session_id,
      timeStartMs: time_start ? new Date(time_start).getTime() : undefined,
      timeEndMs: time_end ? new Date(time_end).getTime() : undefined,
      limit,
      offset,
    });

    const messages: ConversationItem[] = result.rows.map((r) => ({
      id: r.record_id,
      role: r.role as ConversationItem["role"],
      content: r.message_text,
      timestamp: r.recorded_at,
    }));

    return successEnvelope<ConversationQueryData>({ messages, total: result.total }, requestId);
  }

  // Fallback: legacy path (capped at 1000 for safety)
  const allRows = await store.queryL0ForL1(session_id ?? "", undefined, 1000);
  let filtered = session_id ? allRows.filter((r) => r.session_key === session_id || r.session_id === session_id) : allRows;
  if (time_start) { const ms = new Date(time_start).getTime(); filtered = filtered.filter((r) => r.timestamp >= ms); }
  if (time_end) { const ms = new Date(time_end).getTime(); filtered = filtered.filter((r) => r.timestamp <= ms); }
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const messages: ConversationItem[] = page.map((r) => ({ id: r.record_id, role: r.role as ConversationItem["role"], content: r.message_text, timestamp: r.recorded_at }));

  return successEnvelope<ConversationQueryData>({ messages, total }, requestId);
}

async function handleConversationSearch(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationSearchRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, session_id } = parsed.data;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  const result = await executeConversationSearch({
    query,
    limit,
    sessionKey: session_id,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
  });
  const recallLatencyMs = performance.now() - tStart;

  // 非侵入式上报召回指标（service 模式，静默失败，绝不影响业务返回）
  // L0 conversation search 同样属于"召回"行为，strategy 映射逻辑与 L1 相同
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: result.results.map((r) => ({ content: r.content, score: r.score, type: "conversation" })),
      recallStrategy: result.strategy === "fts" ? "keyword" : result.strategy === "none" ? "skipped" : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默失败
  }

  // 非侵入式在当前 Span 上记录 recall query 和 results
  try {
    const otelApi = await import("@opentelemetry/api");
    const activeSpan = otelApi.trace.getSpan(otelApi.context.active());
    if (activeSpan) {
      activeSpan.setAttribute("tdai.recall.query", query);
      activeSpan.setAttribute("tdai.recall.hitCount", result.results.length);
      activeSpan.setAttribute("tdai.recall.strategy", result.strategy || "unknown");
      activeSpan.setAttribute("tdai.recall.level", "l0");
      if (result.results.length > 0) {
        activeSpan.setAttribute("tdai.recall.topScore", Math.max(...result.results.map(r => r.score)));
        const truncatedResults = result.results.slice(0, 5).map(r => ({
          content: r.content.substring(0, 200),
          score: r.score,
        }));
        activeSpan.setAttribute("tdai.recall.results", JSON.stringify(truncatedResults));
      } else {
        activeSpan.setAttribute("tdai.recall.results", "[]");
      }
    }
  } catch {
    // 静默失败
  }

  const messages: ConversationSearchHit[] = result.results.map((r) => ({
    id: r.id, role: r.role as ConversationSearchHit["role"], content: r.content, timestamp: r.recorded_at, score: r.score,
  }));

  return successEnvelope<ConversationSearchData>({ messages }, requestId);
}

async function handleConversationDelete(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = conversationDeleteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { message_ids, session_id } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  let deletedCount = 0;

  if (message_ids && message_ids.length > 0) {
    for (const id of message_ids) {
      const ok = await store.deleteL0(id);
      if (ok) deletedCount++;
    }
  } else if (session_id) {
    // Use deleteL0BySession if available, else fallback
    if (store.deleteL0BySession) {
      deletedCount = await store.deleteL0BySession(session_id);
    } else {
      const rows = await store.queryL0ForL1(session_id, undefined, 10000);
      const sessionRows = rows.filter((r) => r.session_key === session_id || r.session_id === session_id);
      for (const row of sessionRows) {
        const ok = await store.deleteL0(row.record_id);
        if (ok) deletedCount++;
      }
    }
  }

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager.reportMemoryDeleted(auth.serviceId, deletedCount).catch(() => {});
  }

  return successEnvelope<ConversationDeleteData>({ deleted_count: deletedCount }, requestId);
}

async function handleAtomicUpdate(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicUpdateRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { id, content, background } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Read existing record by primary key
  const existing = await store.queryL1Records({ recordIds: [id] });
  if (!existing || existing.length === 0) {
    return errorEnvelope(404, `Atomic note not found: ${id}`, requestId);
  }

  const now = new Date().toISOString();
  const record = existing[0];

  // Build update: content is always overwritten; background (scene_name) only if provided
  const updated: MemoryRecord = {
    id,
    content,
    type: record.type as any,
    priority: record.priority ?? 50,
    scene_name: background !== undefined ? background : (record.scene_name ?? ""),
    source_message_ids: record.source_message_ids ?? [],
    metadata: record.metadata ?? {} as any,
    timestamps: record.timestamps ?? [],
    createdAt: record.created_time,
    updatedAt: now,
    sessionKey: record.session_key ?? "",
    sessionId: record.session_id ?? "",
  };

  const embedding = deps.getEmbedding();
  let emb: Float32Array | undefined;
  if (embedding) { try { emb = await embedding.embed(content); } catch { /* non-fatal */ } }

  await store.upsertL1(updated, emb);
  return successEnvelope<AtomicUpdateData>({ id, updated_at: now }, requestId);
}

async function handleAtomicQuery(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicQueryRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { type, time_start, time_end } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  const offset = parsed.data.offset ?? 0;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // Use paginated query if available
  if (store.queryL1Paginated) {
    const result = await store.queryL1Paginated({ type, timeStart: time_start, timeEnd: time_end, limit, offset });
    const items: AtomicDetail[] = result.rows.map((r) => ({
      id: r.record_id, type: r.type, content: r.content,
      background: r.scene_name || undefined,
      created_at: r.created_time, updated_at: r.updated_time,
    }));
    return successEnvelope<AtomicQueryData>({ items, total: result.total }, requestId);
  }

  // Fallback: legacy
  const allRecords = await store.queryL1Records();
  let filtered = allRecords;
  if (type) filtered = filtered.filter((r) => r.type === type);
  if (time_start) filtered = filtered.filter((r) => r.updated_time >= time_start);
  if (time_end) filtered = filtered.filter((r) => r.updated_time <= time_end);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const items: AtomicDetail[] = page.map((r) => ({
    id: r.record_id, type: r.type, content: r.content,
    background: r.scene_name || undefined,
    created_at: r.created_time, updated_at: r.updated_time,
  }));

  return successEnvelope<AtomicQueryData>({ items, total }, requestId);
}

async function handleAtomicSearch(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicSearchRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { query, type } = parsed.data;
  const limit = parsed.data.limit ?? 5;

  const tStart = performance.now();
  const result = await executeMemorySearch({
    query, limit, type,
    vectorStore: deps.getStore(),
    embeddingService: deps.getEmbedding(),
    logger: deps.logger,
  });
  const recallLatencyMs = performance.now() - tStart;

  // 非侵入式上报召回指标（service 模式，静默失败，绝不影响业务返回）
  try {
    reportRecallMetrics({
      instanceId: auth.serviceId,
      recalledL1Memories: result.results.map((r) => ({ content: r.content, score: r.score, type: r.type })),
      recallStrategy: result.strategy === "fts" ? "keyword" : result.strategy === "none" ? "skipped" : result.strategy,
      recallLatencyMs,
      hasError: false,
    });
  } catch {
    // 静默失败
  }

  // 非侵入式在当前 Span 上记录 recall query 和 results，供在线评测系统消费
  try {
    const { getObservabilityBackend } = await import("../core/report/factory.js");
    const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
    if (ctx && (ctx as any)._traceId) {
      // 通过 OTel API 在当前 span 上添加属性
      try {
        const otelApi = await import("@opentelemetry/api");
        const activeSpan = otelApi.trace.getSpan(otelApi.context.active());
        if (activeSpan) {
          activeSpan.setAttribute("tdai.recall.query", query);
          activeSpan.setAttribute("tdai.recall.hitCount", result.results.length);
          activeSpan.setAttribute("tdai.recall.strategy", result.strategy || "unknown");
          if (result.results.length > 0) {
            activeSpan.setAttribute("tdai.recall.topScore", Math.max(...result.results.map(r => r.score)));
            // 限制 results 属性长度（OTel 属性不宜过长），最多前 5 条
            const truncatedResults = result.results.slice(0, 5).map(r => ({
              content: r.content.substring(0, 200),
              score: r.score,
              type: r.type,
            }));
            activeSpan.setAttribute("tdai.recall.results", JSON.stringify(truncatedResults));
          } else {
            activeSpan.setAttribute("tdai.recall.results", "[]");
          }
          activeSpan.setAttribute("tdai.recall.level", type === "l0" ? "l0" : "l1");
        }
      } catch {
        // OTel API 不可用时静默降级
      }
    }
  } catch {
    // 静默失败
  }

  const items: AtomicSearchHit[] = result.results.map((r) => ({
    id: r.id, type: r.type, content: r.content,
    background: r.scene_name || undefined,
    created_at: r.created_at, updated_at: r.updated_at, score: r.score,
  }));

  return successEnvelope<AtomicSearchData>({ items }, requestId);
}

async function handleAtomicDelete(body: unknown, auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = atomicDeleteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  // deleteL1Batch returns bool, but we need actual count
  // Fall back to per-id deletion for accurate counting
  let deletedCount = 0;
  for (const id of ids) {
    const ok = await store.deleteL1(id);
    if (ok) deletedCount++;
  }

  // Report memory deletion (non-fatal)
  if (deps.quotaManager && deletedCount > 0) {
    deps.quotaManager.reportMemoryDeleted(auth.serviceId, deletedCount).catch(() => {});
  }

  return successEnvelope<AtomicDeleteData>({ deleted_count: deletedCount }, requestId);
}

// ============================
// L2/L3 Profile Sync Helpers (write-through to VDB)
// ============================

const PROFILE_SCOPE = "global";

function md5Hex(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function buildProfileStableId(scope: string, type: "l2" | "l3", filename: string): string {
  const hash = createHash("sha256")
    .update(`${scope}\u0000${type}\u0000${filename}`)
    .digest("hex");
  return `profile:v1:${hash}`;
}

/** Best-effort write-through L2/L3 profile to VDB. Failure is logged but does not break the API. */
async function syncProfileToVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filename: string,
  content: string,
  logger: Logger,
  createdAtOverride?: number,
): Promise<void> {
  if (!store || typeof store.syncProfiles !== "function") return;
  try {
    const now = Date.now();

    // Try to extract created time from META in content
    let createdAtMs = createdAtOverride ?? 0;
    if (!createdAtMs) {
      const metaMatch = content.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----/);
      if (metaMatch) {
        for (const line of metaMatch[1].split("\n")) {
          if (line.startsWith("created: ")) {
            const ts = Date.parse(line.slice(9));
            if (!isNaN(ts)) createdAtMs = ts;
            break;
          }
        }
      }
    }
    if (!createdAtMs) createdAtMs = now;

    const id = buildProfileStableId(PROFILE_SCOPE, type, filename);

    // Probe current VDB version to satisfy the optimistic-lock check in
    // TcvdbMemoryStore.syncProfiles (which compares baselineVersion against
    // the remote version). Without this, the second and subsequent writes
    // to the same profile would be silently skipped as a version conflict.
    // Best-effort: if pullProfiles is unavailable or fails, fall back to
    // undefined and let syncProfiles decide (insert if remote missing,
    // otherwise log + skip — which preserves the previous behaviour).
    let baselineVersion: number | undefined;
    if (typeof store.pullProfiles === "function") {
      try {
        const remote = await store.pullProfiles();
        const existing = remote.find((r) => r.id === id);
        if (existing) baselineVersion = existing.version;
      } catch (err) {
        logger.warn(`${TAG} [profile-sync] pullProfiles probe failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const record: ProfileSyncRecord = {
      id,
      type,
      filename,
      content,
      contentMd5: md5Hex(content),
      version: now,
      createdAtMs,
      updatedAtMs: now,
      baselineVersion,
    };
    await store.syncProfiles([record]);
    logger.debug?.(`${TAG} [profile-sync] ${type} upserted to VDB: ${filename} (baselineVersion=${baselineVersion ?? "new"})`);
  } catch (err) {
    logger.warn(`${TAG} [profile-sync] FAILED to sync ${type} profile ${filename} to VDB: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Best-effort delete L2 profiles from VDB. */
async function deleteProfilesFromVdb(
  store: IMemoryStore | undefined,
  type: "l2" | "l3",
  filenames: string[],
  logger: Logger,
): Promise<void> {
  if (!store || typeof store.deleteProfiles !== "function" || filenames.length === 0) return;
  try {
    const ids = filenames.map((fn) => buildProfileStableId(PROFILE_SCOPE, type, fn));
    await store.deleteProfiles(ids);
    logger.debug?.(`${TAG} [profile-sync] ${type} deleted from VDB: ${filenames.length} files`);
  } catch (err) {
    logger.warn(`${TAG} [profile-sync] FAILED to delete ${type} profiles from VDB: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Best-effort refresh scene_index.json so pipeline sees the user-written L2 files. */
async function refreshSceneIndex(storage: StorageAdapter, logger: Logger): Promise<void> {
  try {
    const { syncSceneIndex } = await import("../core/scene/scene-index.js");
    // Pass empty dataDir; we only use storage in service mode.
    await syncSceneIndex("", storage);
  } catch (err) {
    logger.warn(`${TAG} [scene-index] FAILED to refresh scene index: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================
// L2 Scenario Handlers
// ============================

async function handleScenarioLs(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioListRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path_prefix } = parsed.data;

  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  const prefix = path_prefix
    ? `${StoragePaths.sceneBlocksDir}${path_prefix}`
    : StoragePaths.sceneBlocksDir;

  deps.logger.debug?.(`${TAG} [scenario/ls] storage.type=${storage.type}, prefix="${prefix}"`);

  // One-shot full listing (no pagination; marker-based pagination planned for phase 2)
  const backend = storage.getBackend();
  const result = await backend.listObjects(prefix, { recursive: true });
  deps.logger.debug?.(`${TAG} [scenario/ls] listObjects returned ${result.entries.length} entries`);
  const allEntries = result.entries;

  // Read scene_index.json for summary + created/updated lookup
  const { readSceneIndex } = await import("../core/scene/scene-index.js");
  const sceneIndex = await readSceneIndex("", storage);
  const indexMap = new Map(sceneIndex.map((e) => [e.filename, e]));

  const entries: ScenarioEntry[] = allEntries.map((e) => {
    const externalPath = e.key.startsWith(StoragePaths.sceneBlocksDir)
      ? e.key.slice(StoragePaths.sceneBlocksDir.length)
      : e.key;
    const displayPath = e.isDirectory && !externalPath.endsWith("/") ? `${externalPath}/` : externalPath;
    const indexEntry = indexMap.get(externalPath);
    const fallbackTime = e.lastModified.toISOString();
    return {
      path: displayPath,
      summary: indexEntry?.summary || undefined,
      created_at: indexEntry?.created || fallbackTime,
      updated_at: indexEntry?.updated || fallbackTime,
    };
  });

  return successEnvelope<ScenarioListData>({ entries, total: entries.length }, requestId);
}

async function handleScenarioRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioReadRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  const content = await storage.readFile(key);

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<ScenarioFile>({
      path,
      content: null as unknown as string,
      created_at: null as unknown as string,
      updated_at: null as unknown as string,
    }, requestId);
  }

  // Parse META for created/updated
  const now = new Date().toISOString();
  let createdAt = now;
  let updatedAt = now;

  const metaMatch = content.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----/);
  if (metaMatch) {
    for (const line of metaMatch[1].split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) {
        const k = line.slice(0, idx);
        const v = line.slice(idx + 2);
        if (k === "created") createdAt = v;
        if (k === "updated") updatedAt = v;
      }
    }
  } else {
    // Fallback: try scene_index
    const { readSceneIndex } = await import("../core/scene/scene-index.js");
    const sceneIndex = await readSceneIndex("", storage);
    const entry = sceneIndex.find((e) => e.filename === path);
    if (entry) {
      createdAt = entry.created || now;
      updatedAt = entry.updated || now;
    } else {
      const stat = await storage.stat(key);
      if (stat) {
        createdAt = new Date(stat.lastModified).toISOString();
        updatedAt = createdAt;
      }
    }
  }

  return successEnvelope<ScenarioFile>({
    path, content,
    created_at: createdAt,
    updated_at: updatedAt,
  }, requestId);
}

async function handleScenarioWrite(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioWriteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path, content, summary } = parsed.data;
  // This route writes META directly, bypassing L2 entirely. Apply the same
  // summary cap as the extraction path so the injected system prompt cannot
  // be inflated through the API.
  const boundedSummary = summary === undefined ? undefined : clampSceneSummary(summary);

  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;

  // Existence check: path must already exist (no upsert/create)
  const existing = await storage.readFile(key);
  if (existing === null) return errorEnvelope(404, `Scenario file not found: ${path}`, requestId);

  // Parse existing META to preserve created + update updated/summary
  const now = new Date().toISOString();
  let finalContent: string;

  const metaMatch = existing.match(/^-----META-START-----\n([\s\S]*?)\n-----META-END-----\n?/);
  if (metaMatch) {
    // Parse existing META fields
    const metaBlock = metaMatch[1];
    const metaFields: Record<string, string> = {};
    for (const line of metaBlock.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0) metaFields[line.slice(0, idx)] = line.slice(idx + 2);
    }

    // Update fields
    metaFields["updated"] = now;
    if (boundedSummary !== undefined) metaFields["summary"] = boundedSummary;

    const newMeta = Object.entries(metaFields).map(([k, v]) => `${k}: ${v}`).join("\n");
    finalContent = `-----META-START-----\n${newMeta}\n-----META-END-----\n\n${content}`;
  } else {
    // META missing or corrupted — rebuild
    const metaLines = [
      `created: ${now}`,
      `updated: ${now}`,
    ];
    if (boundedSummary !== undefined) metaLines.push(`summary: ${boundedSummary}`);
    finalContent = `-----META-START-----\n${metaLines.join("\n")}\n-----META-END-----\n\n${content}`;
  }

  await storage.writeFile(key, finalContent);

  // Sync L2 to VDB profiles + refresh scene index (best-effort)
  const store = deps.getStore();
  await syncProfileToVdb(store, "l2", path, finalContent, deps.logger);
  await refreshSceneIndex(storage, deps.logger);

  return successEnvelope<ScenarioWriteData>({ path, updated_at: now }, requestId);
}

async function handleScenarioRm(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = scenarioRmRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { path } = parsed.data;

  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  const key = `${StoragePaths.sceneBlocksDir}${path}`;
  // Collect filenames to delete from VDB (single file or all files under a directory)
  let removedFilenames: string[] = [];
  if (path.endsWith("/")) {
    try { removedFilenames = await storage.readdirNames(key, ".md"); } catch { /* ignore */ }
    await storage.rmdir(key);
  } else {
    removedFilenames = [path];
    await storage.unlink(key);
  }

  // Delete L2 profiles from VDB (best-effort)
  const store = deps.getStore();
  await deleteProfilesFromVdb(store, "l2", removedFilenames, deps.logger);
  await refreshSceneIndex(storage, deps.logger);

  return successEnvelope(undefined, requestId);
}

// ============================
// L3 Core Handlers
// ============================

async function handleCoreRead(_body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  deps.logger.debug?.(`${TAG} [core/read] storage.type=${storage.type}, key="${StoragePaths.persona}"`);
  const content = await storage.readFile(StoragePaths.persona);
  deps.logger.debug?.(`${TAG} [core/read] readFile result: ${content === null ? "null (not found)" : `${content.length} chars`}`);

  // File not found → return 200 with null content (not 404)
  if (content === null) {
    return successEnvelope<CoreFile>({
      content: null as unknown as string,
      created_at: null as unknown as string,
      updated_at: null as unknown as string,
    }, requestId);
  }

  const stat = await storage.stat(StoragePaths.persona);
  const now = new Date().toISOString();

  // Clients that read L3 through this endpoint (openclaw-plugin, hermes v2, the
  // SDKs) inject the stored body verbatim, including the scene navigation block
  // written by an older L2 round. Clamp its summaries here so a legacy persona
  // cannot bypass the cap. Read-only: nothing is written and `updated_at` still
  // reflects the file on disk. `handleCoreWrite` strips the block on the way
  // back in, so this cannot lose data on a read-modify-write round trip.
  const bounded = clampSceneNavigationSummaries(content);
  if (bounded !== content) {
    deps.logger.debug?.(
      `${TAG} [core/read] clamped legacy scene navigation summaries (${content.length}→${bounded.length} chars)`,
    );
  }

  return successEnvelope<CoreFile>({
    content: bounded,
    created_at: stat ? new Date(stat.createdAt).toISOString() : now,
    updated_at: stat ? new Date(stat.lastModified).toISOString() : now,
  }, requestId);
}

async function handleCoreWrite(body: unknown, _auth: V2AuthContext, requestId: string, deps: V2RouterDeps): Promise<ApiResponseEnvelope> {
  const parsed = coreWriteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
  const { content } = parsed.data;

  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);

  // Normalize before persistence: persona body must NOT contain Scene Navigation
  // (a derived section rebuilt from scene_index.json) or stray surrounding
  // whitespace. Both COS and VDB get the *exact* same bytes so md5(content) is
  // a stable identity across stores. Without this, /v2/core/write callers that
  // post the raw round-tripped body (which includes the navigation footer and
  // a trailing newline appended by refreshPersonaNavigation) would write a
  // mismatched copy to each store, and pullProfilesToLocal would later treat
  // the persona as corrupted and delete the COS copy.
  const personaBody = stripSceneNavigation(content).trim();

  await storage.writeFile(StoragePaths.persona, personaBody);

  // Sync L3 persona to VDB profiles (best-effort)
  const store = deps.getStore();
  await syncProfileToVdb(store, "l3", "persona.md", personaBody, deps.logger);

  return successEnvelope<CoreWriteData>({ updated_at: new Date().toISOString() }, requestId);
}

// ─────────────────────────────────────────────────────────────────────────
// /v2/pipeline/status — standalone-only introspection.
// Returns per-L-type queue/in-flight stats by reading the in-memory task
// queue (LocalStateBackend.listQueuedTasks) and worker's running set
// (PipelineWorker.getRunningTasks). idle = queued===0 && running===0.
// Mirrors the old MemoryPipelineManager.getQueueSizes() {l1Idle,l2Idle,l3Idle}
// semantics so seed clients can wait specifically for L1 to drain (without
// being blocked by slow L2/L3 cascades).
// Service mode returns 404 (route not exposed).
// ─────────────────────────────────────────────────────────────────────────

interface LayerStatus {
  /** Tasks waiting to be consumed (in queue). */
  queued: number;
  /** Tasks consumed by worker but not yet completed/failed. */
  running: number;
  /** Distinct sessionIds of queued tasks (for diagnostics). */
  queued_sessions: string[];
  /** Distinct sessionIds of running tasks (for diagnostics). */
  running_sessions: string[];
  /** True iff queued===0 && running===0. */
  idle: boolean;
}

interface PipelineStatusData {
  l1: LayerStatus;
  l2: LayerStatus;
  l3: LayerStatus;
}

function emptyLayer(): LayerStatus {
  return { queued: 0, running: 0, queued_sessions: [], running_sessions: [], idle: true };
}

async function handlePipelineStatus(
  _body: unknown,
  _auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
): Promise<ApiResponseEnvelope> {
  // Service mode does not expose this endpoint — pretend it's not routed.
  if (deps.deployMode !== "standalone") {
    return errorEnvelope(404, "Not found", requestId);
  }

  // Legacy standalone (no stateBackend / no worker) — pipeline isn't running.
  if (!deps.stateBackend || !deps.pipelineWorker) {
    return errorEnvelope(503, "Pipeline not running (legacy standalone mode)", requestId);
  }

  // listQueuedTasks is optional on IStateBackend; LocalStateBackend implements
  // it, remote backends may not. Service mode never reaches here anyway.
  if (!deps.stateBackend.listQueuedTasks) {
    return errorEnvelope(
      503,
      "stateBackend does not support listQueuedTasks (status endpoint requires LocalStateBackend)",
      requestId,
    );
  }

  const queued = await deps.stateBackend.listQueuedTasks();
  const running = deps.pipelineWorker.getRunningTasks();

  const layers: Record<"L1" | "L2" | "L3", LayerStatus> = {
    L1: emptyLayer(),
    L2: emptyLayer(),
    L3: emptyLayer(),
  };
  // Track sessionIds in a Set per layer/category for de-dup, then materialize.
  const queuedSessionSets: Record<"L1" | "L2" | "L3", Set<string>> = {
    L1: new Set(),
    L2: new Set(),
    L3: new Set(),
  };
  const runningSessionSets: Record<"L1" | "L2" | "L3", Set<string>> = {
    L1: new Set(),
    L2: new Set(),
    L3: new Set(),
  };

  for (const t of queued) {
    if (t.type === "L1" || t.type === "L2" || t.type === "L3") {
      layers[t.type].queued++;
      queuedSessionSets[t.type].add(t.sessionId);
    }
    // "flush" tasks behave like L1 work (see executor.executeFlush fallback);
    // tally them under L1 so the seed-v2 idle wait doesn't miss them.
    if (t.type === "flush") {
      layers.L1.queued++;
      queuedSessionSets.L1.add(t.sessionId);
    }
  }
  for (const t of running) {
    if (t.type === "L1" || t.type === "L2" || t.type === "L3") {
      layers[t.type].running++;
      runningSessionSets[t.type].add(t.sessionId);
    }
    if (t.type === "flush") {
      layers.L1.running++;
      runningSessionSets.L1.add(t.sessionId);
    }
  }
  for (const k of ["L1", "L2", "L3"] as const) {
    layers[k].queued_sessions = Array.from(queuedSessionSets[k]).sort();
    layers[k].running_sessions = Array.from(runningSessionSets[k]).sort();
    layers[k].idle = layers[k].queued === 0 && layers[k].running === 0;
  }

  const data: PipelineStatusData = {
    l1: layers.L1,
    l2: layers.L2,
    l3: layers.L3,
  };

  return successEnvelope<PipelineStatusData>(data, requestId);
}

// ============================
// Helpers
// ============================

/**
 * Format a Date as YYYY-MM-DD in local timezone, matching the convention used by
 * v1 l0-recorder and l1-writer for daily JSONL shard names. Local copy to keep
 * v2-router self-contained (avoids exporting a util just for one call site).
 */
function formatLocalDateForJsonl(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ============================
// Exported for testing
// ============================

export {
  handleConversationAdd,
  handleConversationQuery,
  handleConversationSearch,
  handleConversationDelete,
  handleAtomicUpdate,
  handleAtomicQuery,
  handleAtomicSearch,
  handleAtomicDelete,
  handleScenarioLs,
  handleScenarioRead,
  handleScenarioWrite,
  handleScenarioRm,
  handleCoreRead,
  handleCoreWrite,
  handlePipelineStatus,
};
