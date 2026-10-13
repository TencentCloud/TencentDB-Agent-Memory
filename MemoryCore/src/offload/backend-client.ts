/**
 * Backend HTTP Client for Context Offload.
 *
 * When `backendUrl` is configured, L1/L1.5/L2/L4 LLM calls are routed
 * through this client to the backend service. The backend handles
 * prompt construction + LLM invocation; the client handles data
 * collection and file I/O.
 *
 * All methods throw on failure — callers are responsible for fallback.
 */
import type { OffloadEntry, ToolPair, TaskJudgment, PluginLogger } from "./types.js";
import { traceOffloadModelIo } from "./opik-tracer.js";
import * as https from "node:https";
import * as http from "node:http";

// ─── Request / Response Types ────────────────────────────────────────────────

export interface L1Request {
  recentMessages: string;
  toolPairs: Array<{
    toolName: string;
    toolCallId: string;
    params: unknown;
    result: unknown;
    timestamp: string;
  }>;
  pluginConfig?: Record<string, unknown>;
}

export interface L1Response {
  entries: OffloadEntry[];
}

export interface L15Request {
  recentMessages: string;
  currentMmd?: {
    filename: string;
    content: string;
    path: string;
  } | null;
  availableMmdMetas: Array<{
    filename: string;
    path: string;
    taskGoal: string;
    doneCount: number;
    doingCount: number;
    todoCount: number;
    updatedTime?: string | null;
    nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
  }>;
}

export interface L15Response extends TaskJudgment {}

export interface L2Request {
  existingMmd: string | null;
  newEntries: Array<{
    tool_call_id: string;
    tool_call: string;
    summary: string;
    timestamp: string;
  }>;
  recentHistory: string | null;
  currentTurn: string | null;
  taskLabel: string;
  mmdPrefix: string;
  mmdCharCount: number;
}

export interface L2Response {
  fileAction: "write" | "replace";
  mmdContent?: string;
  replaceBlocks?: Array<{
    startLine: number;
    endLine: number;
    content: string;
  }>;
  nodeMapping: Record<string, string>;
}

export interface L4Request {
  mmdFilename: string;
  mmdContent: string;
  offloadEntries: OffloadEntry[];
  skillFocus: string | null;
}

export interface L4Response {
  skillName: string;
  skillDescription: string;
  skillContent: string;
}

/**
 * Arbitrary key/value payload uploaded to the backend `/offload/v1/store` endpoint.
 * The backend stores the raw JSON body verbatim; see `internal/handler/store.go`.
 */
export type StoreStatePayload = Record<string, unknown>;

export interface StoreStateResponse {
  insertedId?: string;
}

// ─── BackendClient ───────────────────────────────────────────────────────────

export class BackendClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  /** Hardcoded timeout for all backend calls (L1/L1.5/L2/L4) */
  private static readonly TIMEOUT_MS = 120_000;
  /** Bound response bytes before decoding or parsing remote content. */
  private static readonly MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  private logger: PluginLogger;
  private sessionKeyFn: () => string | null;
  /** Resolves the value of the `X-User-Id` header sent on every call. */
  private userIdFn: () => string | null;
  /** Resolves the value of the `X-Task-Id` header sent on every call (optional). */
  private taskIdFn: () => string | null;

  constructor(
    baseUrl: string,
    logger: PluginLogger,
    apiKey?: string,
    _defaultTimeoutMs?: number, // kept for backward compat, ignored
    sessionKeyFn?: () => string | null,
    userIdFn?: () => string | null,
    taskIdFn?: () => string | null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.logger = logger;
    this.sessionKeyFn = sessionKeyFn ?? (() => null);
    this.userIdFn = userIdFn ?? (() => null);
    this.taskIdFn = taskIdFn ?? (() => null);
  }

  /** L1 Summarize — synchronous await (used by assemble flush + force trigger) */
  async l1Summarize(req: L1Request): Promise<L1Response> {
    this.logger.debug?.(`[context-offload] L1 >>> summarize ${req.toolPairs.length} pairs`);
    const startMs = Date.now();
    const resp = await this.post<L1Response>("/offload/v1/l1/summarize", req, BackendClient.TIMEOUT_MS);
    const durationMs = Date.now() - startMs;
    const entryCount = resp.entries?.length ?? 0;
    this.logger.debug?.(`[context-offload] L1 <<< ${entryCount} entries`);
    traceOffloadModelIo({
      sessionKey: this.sessionKeyFn(),
      stage: "L1.backend",
      provider: "backend",
      model: `backend:${this.baseUrl}`,
      url: `${this.baseUrl}/offload/v1/l1/summarize`,
      systemPrompt: "(constructed by backend)",
      userPrompt: JSON.stringify(req),
      responseContent: JSON.stringify(resp),
      usage: { entriesCount: entryCount },
      status: "ok",
      durationMs,
      logger: this.logger,
    });
    return resp;
  }

  /** L1.5 Task Judgment — synchronous await, uses unified timeout */
  async l15Judge(req: L15Request): Promise<L15Response> {
    this.logger.debug?.(
      `[context-offload] L1.5 >>> judge: hasCurrentMmd=${!!req.currentMmd}, availableMmds=${req.availableMmdMetas.length}, recentMessages=${req.recentMessages.length} chars`,
    );
    const startMs = Date.now();
    const resp = await this.post<L15Response>("/offload/v1/l15/judge", req, BackendClient.TIMEOUT_MS);
    const durationMs = Date.now() - startMs;
    this.logger.debug?.(
      `[context-offload] L1.5 <<< completed=${resp.taskCompleted === true}, continuation=${resp.isContinuation === true}, hasContinuationFile=${!!resp.continuationMmdFile}, hasNewLabel=${!!resp.newTaskLabel}, longTask=${resp.isLongTask === true}`,
    );
    traceOffloadModelIo({
      sessionKey: this.sessionKeyFn(),
      stage: "L1.5.backend",
      provider: "backend",
      model: `backend:${this.baseUrl}`,
      url: `${this.baseUrl}/offload/v1/l15/judge`,
      systemPrompt: "(constructed by backend)",
      userPrompt: JSON.stringify(req),
      responseContent: JSON.stringify(resp),
      status: "ok",
      durationMs,
      logger: this.logger,
    });
    return resp;
  }

  /** L2 MMD Generation — async background, uses unified timeout */
  async l2Generate(req: L2Request): Promise<L2Response> {
    this.logger.debug?.(
      `[context-offload] L2 >>> generate: entries=${req.newEntries.length}, hasExistingMmd=${!!req.existingMmd}`,
    );
    const startMs = Date.now();
    const resp = await this.post<L2Response>("/offload/v1/l2/generate", req, BackendClient.TIMEOUT_MS);
    const durationMs = Date.now() - startMs;
    const mappingCount = Object.keys(resp.nodeMapping ?? {}).length;
    this.logger.debug?.(
      `[context-offload] L2 <<< replace=${resp.fileAction === "replace"}, mmdContent=${resp.mmdContent ? `${resp.mmdContent.length} chars` : "null"}, replaceBlocks=${resp.replaceBlocks?.length ?? 0}, nodeMapping=${mappingCount}`,
    );
    traceOffloadModelIo({
      sessionKey: this.sessionKeyFn(),
      stage: "L2.backend",
      provider: "backend",
      model: `backend:${this.baseUrl}`,
      url: `${this.baseUrl}/offload/v1/l2/generate`,
      systemPrompt: "(constructed by backend)",
      userPrompt: JSON.stringify(req),
      responseContent: JSON.stringify(resp),
      status: "ok",
      durationMs,
      logger: this.logger,
    });
    return resp;
  }

  /** L4 Skill Generation — synchronous await, uses unified timeout */
  async l4Generate(req: L4Request): Promise<L4Response> {
    this.logger.debug?.(
      `[context-offload] L4 >>> generate: entries=${req.offloadEntries.length}, hasSkillFocus=${!!req.skillFocus}`,
    );
    const startMs = Date.now();
    const resp = await this.post<L4Response>("/offload/v1/l4/generate", req, BackendClient.TIMEOUT_MS);
    const durationMs = Date.now() - startMs;
    this.logger.debug?.(
      `[context-offload] L4 <<< hasSkillName=${!!resp.skillName}, content=${resp.skillContent?.length ?? 0} chars`,
    );
    traceOffloadModelIo({
      sessionKey: this.sessionKeyFn(),
      stage: "L4.backend",
      provider: "backend",
      model: `backend:${this.baseUrl}`,
      url: `${this.baseUrl}/offload/v1/l4/generate`,
      systemPrompt: "(constructed by backend)",
      userPrompt: JSON.stringify(req),
      responseContent: JSON.stringify(resp),
      status: "ok",
      durationMs,
      logger: this.logger,
    });
    return resp;
  }

  /**
   * Upload an arbitrary state payload to the backend `/offload/v1/store` endpoint.
   * Fire-and-forget style — the caller is expected to `.catch(...)` rejections.
   * Uses a short timeout so reporting never blocks hook execution meaningfully.
   */
  async storeState(payload: StoreStatePayload): Promise<StoreStateResponse> {
    // Short timeout — reporting must never stall the plugin
    const timeoutMs = 10_000;
    const startMs = Date.now();
    try {
      const resp = await this.post<StoreStateResponse>("/offload/v1/store", payload, timeoutMs);
      const durationMs = Date.now() - startMs;
      this.logger.debug?.(
        `[context-offload] store <<< success (${durationMs}ms)`,
      );
      return resp;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      this.logger.warn(`[context-offload] store !!! failed after ${durationMs}ms`);
      throw err;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const startMs = Date.now();

    const bodyStr = JSON.stringify(body);
    this.logger.debug?.(`[context-offload] HTTP >>> POST ${path} (${bodyStr.length} bytes, timeout=${timeoutMs}ms)`);

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(bodyStr)),
    };
    if (this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }
    // Propagate identity headers so the backend can key stored state by
    // `X-User-Id` (used as Mongo `_id` in /store) and scope by task.
    try {
      const uid = this.userIdFn();
      if (uid) reqHeaders["X-User-Id"] = uid;
    } catch { /* ignore — identity headers are best-effort */ }
    try {
      const tid = this.taskIdFn();
      if (tid) reqHeaders["X-Task-Id"] = tid;
    } catch { /* ignore */ }

    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Backend URL must use HTTP or HTTPS");
    }
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers: reqHeaders,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("Backend response aborted")));
          res.on("close", () => {
            if (!res.complete) fail(new Error("Backend response aborted"));
          });
          const oversized = () => {
            fail(new Error("Backend response exceeds 16 MiB"));
            res.destroy();
          };
          const declaredBytes = Number(res.headers["content-length"]);
          if (declaredBytes > BackendClient.MAX_RESPONSE_BYTES) {
            oversized();
            return;
          }
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > BackendClient.MAX_RESPONSE_BYTES) {
              oversized();
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (settled) return;
            clearTimeout(timer);
            const data = Buffer.concat(chunks, bytes).toString("utf8");
            const durationMs = Date.now() - startMs;

            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              this.logger.warn(
                `[context-offload] HTTP <<< ${path}: ${res.statusCode} (${durationMs}ms)`,
              );
              fail(new Error(`Backend API error ${res.statusCode}`));
              return;
            }

            try {
              const parsed = JSON.parse(data) as T;
              this.logger.debug?.(
                `[context-offload] HTTP <<< ${path}: ${res.statusCode} (${durationMs}ms, ${data.length} bytes)`,
              );
              settled = true;
              resolve(parsed);
            } catch {
              fail(new Error("Backend response JSON parse error"));
            }
          });
        },
      );

      // Construct the request before scheduling: invalid headers must not leave
      // a timer referencing a request that was never created.
      timer = setTimeout(() => {
        const error = new Error("timeout");
        fail(error);
        req.destroy(error);
      }, timeoutMs);
      req.on("error", (err: Error) => {
        if (settled) return;
        const durationMs = Date.now() - startMs;
        const errMsg = err.message;
        const isTimeout = errMsg.includes("timeout");
        this.logger.warn(
          `[context-offload] HTTP !!! ${path}: ${isTimeout ? "TIMEOUT" : "ERROR"} after ${durationMs}ms`,
        );
        fail(err);
      });

      req.write(bodyStr);
      req.end();
    });
  }
}
