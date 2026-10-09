/**
 * HttpServerBase — shared HTTP server logic for all HTTP-based TDAI platforms.
 *
 * Symmetric counterpart to McpServerBase for HTTP/Plugin platforms
 * (Hermes/Gateway, Dify, n8n, …). Owns http.Server + TdaiCore.
 *
 * Subclasses provide:
 *   createAdapter()      — platform-specific HostAdapter
 *   onAfterInit()        — post-init setup (start background tasks, log posture, …)
 *   onBeforeShutdown()   — pre-shutdown flush
 *   handleCustomRoute()  — extra routes beyond the 6 standard ones
 *   buildMemoryConfig()  — override when you have a pre-parsed MemoryTdaiConfig
 *
 * Standard endpoints (handled in base):
 *   GET  /health
 *   POST /recall
 *   POST /capture
 *   POST /search/memories
 *   POST /search/conversations
 *   POST /session/end
 *
 * Note: request/response types are defined inline here to avoid a circular
 * dependency with src/gateway/types.ts (gateway imports adapters; adapters
 * must not import gateway).
 */

import http from "node:http";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { TdaiCore } from "../core/tdai-core.js";
import { parseConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import type { Logger, HostAdapter } from "../core/types.js";
import { makeStderrLogger } from "./utils.js";
import type { StandaloneLLMConfig } from "./standalone/llm-runner.js";
import { MemoryOperations, MemoryOperationError } from "./memory-operations.js";

export type { StandaloneLLMConfig };

const VERSION = "0.1.0";
const TAG = "[tdai-http]";

// ============================
// Options
// ============================

export interface HttpServerBaseOptions {
  dataDir: string;
  llmConfig: StandaloneLLMConfig;
  port: number;
  /** Bind address (default "127.0.0.1"). */
  host?: string;
  /** Bearer auth token. When unset, all routes are open (log warns at startup). */
  apiKey?: string;
  /** CORS allow-list. Empty = no CORS headers. `["*"]` = wildcard. */
  corsOrigins?: string[];
  memoryConfigOverride?: Record<string, unknown>;
  userId?: string;
  logger?: Logger;
  sessionFilter?: SessionFilter;
}

// ============================
// Inline request body types
// (private to this file — avoids importing from src/gateway/types.ts)
// ============================

// Note: there is deliberately no `user_id` field. TdaiCore does not scope
// storage by user, so accepting one would silently imply isolation that does
// not exist. See docs/architecture.md before adding per-user tenancy.

interface RecallReqBody {
  query: string;
  session_key: string;
}

interface CaptureReqBody {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  messages?: unknown[];
}

interface MemSearchReqBody {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

interface ConvSearchReqBody {
  query: string;
  limit?: number;
  session_key?: string;
}

interface SessionEndReqBody {
  session_key: string;
}

// ============================
// HttpServerBase
// ============================

export abstract class HttpServerBase {
  protected readonly opts: HttpServerBaseOptions;
  protected readonly logger: Logger;
  protected adapter!: HostAdapter;
  protected core!: TdaiCore;
  /** Transport-neutral memory operations — shared with McpServerBase. */
  protected ops!: MemoryOperations;
  private server: http.Server | null = null;
  private signalHandler: (() => void) | null = null;
  private startTime = Date.now();

  constructor(opts: HttpServerBaseOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? makeStderrLogger();
  }

  /** Create the platform-specific HTTP host adapter. */
  protected abstract createAdapter(): HostAdapter;

  /** Called after TdaiCore is initialized — start timers, log posture, etc. */
  protected async onAfterInit(): Promise<void> {}

  /** Called before http.Server.close() and core.destroy(). */
  protected async onBeforeShutdown(): Promise<void> {}

  /**
   * Handle a route not covered by the 6 standard endpoints.
   * Called for every unmatched `{METHOD} {pathname}`.
   * Return true if the response was sent; false to respond 404.
   */
  protected async handleCustomRoute(
    _method: string,
    _pathname: string,
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Build the MemoryTdaiConfig for TdaiCore.
   * Default: parse opts.memoryConfigOverride.
   * Override in subclasses with a pre-parsed config (e.g. TdaiGateway with YAML).
   */
  protected buildMemoryConfig(): MemoryTdaiConfig {
    return parseConfig(this.opts.memoryConfigOverride ?? {});
  }

  // ============================
  // Lifecycle
  // ============================

  async start(): Promise<void> {
    initDataDirectories(this.opts.dataDir);
    await this.initCore();
    await this.onAfterInit();

    const { port, host = "127.0.0.1" } = this.opts;
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof MemoryOperationError) {
          sendError(res, err.statusCode, msg);
          return;
        }
        this.logger.error(`${TAG} Unhandled request error: ${msg}`);
        sendError(res, 500, msg);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`${TAG} Server listening on http://${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });

    this.signalHandler = () => {
      this.logger.info(`${TAG} Signal received — shutting down`);
      void this.stop().then(() => process.exit(0));
    };
    process.on("SIGTERM", this.signalHandler);
    process.on("SIGINT", this.signalHandler);
  }

  async stop(): Promise<void> {
    this.logger.info(`${TAG} Shutting down...`);

    // Detach before closing — a server that is started and stopped repeatedly
    // in one process must not accumulate process-level listeners.
    if (this.signalHandler) {
      process.off("SIGTERM", this.signalHandler);
      process.off("SIGINT", this.signalHandler);
      this.signalHandler = null;
    }

    await this.onBeforeShutdown();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    await this.core.destroy();
    this.logger.info(`${TAG} Stopped`);
  }

  // ============================
  // Core initialisation
  // ============================

  /**
   * Build the adapter, TdaiCore and the operations facade.
   * Protected so a harness can substitute a prepared core without booting
   * the real storage stack.
   */
  protected async initCore(): Promise<void> {
    this.adapter = this.createAdapter();
    const memoryConfig = this.buildMemoryConfig();
    const sessionFilter = this.opts.sessionFilter ?? new SessionFilter([]);

    this.core = new TdaiCore({
      hostAdapter: this.adapter,
      config: memoryConfig,
      sessionFilter,
    });

    await this.core.initialize();
    this.ops = new MemoryOperations(this.core, this.logger, TAG);
    this.logger.info(`${TAG} TdaiCore initialized (dataDir=${this.opts.dataDir})`);
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    this.applyCorsHeaders(req, res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health is always reachable without auth (k8s probes, docker health-check).
    if (method === "GET" && pathname === "/health") {
      this.handleHealth(res);
      return;
    }

    if (!this.checkAuth(req, res)) return;

    switch (`${method} ${pathname}`) {
      case "POST /recall":
        await this.handleRecall(req, res);
        break;
      case "POST /capture":
        await this.handleCapture(req, res);
        break;
      case "POST /search/memories":
        await this.handleSearchMemories(req, res);
        break;
      case "POST /search/conversations":
        await this.handleSearchConversations(req, res);
        break;
      case "POST /session/end":
        await this.handleSessionEnd(req, res);
        break;
      default: {
        const handled = await this.handleCustomRoute(method, pathname, req, res);
        if (!handled) sendError(res, 404, `Not found: ${method} ${pathname}`);
        break;
      }
    }
  }

  // ============================
  // Auth & CORS gates
  // ============================

  /**
   * Verify `Authorization: Bearer <apiKey>` using constant-time comparison.
   * When apiKey is unset the gate is a no-op (documented default — logged as WARN
   * by subclasses that care, e.g. TdaiGateway.logSecurityPosture).
   */
  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const expected = this.opts.apiKey;
    if (!expected) return true;

    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      sendError(res, 401, "Unauthorized: missing Bearer token");
      return false;
    }
    const provided = header.slice("Bearer ".length).trim();
    if (!provided || !safeEqual(provided, expected)) {
      sendError(res, 401, "Unauthorized: invalid token");
      return false;
    }
    return true;
  }

  private applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const allow = this.opts.corsOrigins ?? [];
    if (allow.length === 0) return;

    if (allow.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return;
    }

    const requestOrigin = req.headers["origin"];
    if (typeof requestOrigin !== "string" || !allow.includes(requestOrigin)) {
      res.setHeader("Vary", "Origin");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }

  // ============================
  // Standard route handlers
  // ============================

  private handleHealth(res: http.ServerResponse): void {
    sendJson(res, 200, {
      status: this.core.getVectorStore() ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: !!this.core.getVectorStore(),
        embeddingService: !!this.core.getEmbeddingService(),
      },
    });
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallReqBody>(req);
    const result = await this.ops.recall({
      query: body.query,
      sessionKey: body.session_key,
    });
    sendJson(res, 200, {
      context: result.appendSystemContext ?? "",
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
    });
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureReqBody>(req);
    const result = await this.ops.capture({
      userText: body.user_content,
      assistantText: body.assistant_content,
      sessionKey: body.session_key,
      sessionId: body.session_id,
      messages: body.messages,
    });
    sendJson(res, 200, {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    });
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemSearchReqBody>(req);
    const result = await this.ops.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
    });
    sendJson(res, 200, { results: result.text, total: result.total, strategy: result.strategy });
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConvSearchReqBody>(req);
    const result = await this.ops.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
    });
    sendJson(res, 200, { results: result.text, total: result.total });
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndReqBody>(req);
    await this.ops.sessionEnd(body.session_key);
    sendJson(res, 200, { flushed: true });
  }
}

// ============================
// Exported utilities
// (also usable by handleCustomRoute implementations in subclasses)
// ============================

export async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
