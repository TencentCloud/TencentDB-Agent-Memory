/**
 * Dify adapter — inbound REST server (`DifyMemoryAdapter`).
 *
 * Two integration surfaces in one zero-dependency `node:http` server
 * (mirroring the Gateway's no-Express style):
 *
 *   READ  — `POST /retrieval` implements Dify's External Knowledge Base API.
 *           Dify calls us during Knowledge Retrieval; `knowledge_id` routes to
 *           L1 memories (`tdai-memories`) or L0 conversations
 *           (`tdai-conversations`). Per-record scores come from the SDK's
 *           structured `items`, batch-normalized to 0..1 (top hit = 1.0)
 *           before `score_threshold` filtering.
 *   WRITE — `POST /tools/capture` + `POST /tools/recall`, importable into a
 *           Dify app as a Custom Tool via `GET /openapi.json`.
 *
 * Auth: Dify's spec mandates specific error bodies — missing/malformed
 * Authorization → HTTP 403 `{error_code: 1001}`, wrong key → 403
 * `{error_code: 1002}` (used on ALL protected routes for consistency;
 * `/health` and `/openapi.json` stay open). When no API key is configured the
 * adapter runs open and warns loudly at startup, matching the Gateway's
 * security posture logging.
 *
 * Built on the Adapter SDK: extends `BasePlatformAdapter`, consumes only
 * `MemoryClient` — works with either transport unchanged.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { BasePlatformAdapter } from "../../adapter-sdk/base-platform-adapter.js";
import type { MemoryClient } from "../../adapter-sdk/types.js";
import type { Logger } from "../../core/types.js";
import {
  KNOWLEDGE_ID_MEMORIES,
  KNOWLEDGE_ID_CONVERSATIONS,
  type DifyRetrievalRequest,
  type DifyRetrievalRecord,
  type DifyRetrievalResponse,
  type DifyErrorBody,
  type DifyCaptureToolRequest,
  type DifyCaptureToolResponse,
  type DifyRecallToolRequest,
  type DifyRecallToolResponse,
} from "./types.js";
import { buildOpenApiSpec } from "./openapi.js";

const TAG = "[tdai-adapter] [dify]";

// ============================
// Options
// ============================

export interface DifyMemoryAdapterOptions {
  client: MemoryClient;
  /** Listen port. Default 8421 (`TDAI_DIFY_PORT`); pass 0 for ephemeral (tests). */
  port?: number;
  /** Bind host. Default "127.0.0.1" (`TDAI_DIFY_HOST`). */
  host?: string;
  /**
   * Shared secret expected as `Authorization: Bearer <key>` on every route
   * except `/health` and `/openapi.json`. Unset → open mode + startup WARN.
   */
  apiKey?: string;
  /** Session key for /tools/* calls that omit one. Default "dify:default". */
  defaultSessionKey?: string;
  logger?: Logger;
}

const DEFAULT_PORT = 8421;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SESSION_KEY = "dify:default";
const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 5;

// ============================
// Small HTTP helpers (gateway-style)
// ============================

/** Marker error: request body was not valid JSON (client fault → HTTP 400). */
class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new InvalidJsonBodyError());
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function difyError(res: http.ServerResponse, httpStatus: number, errorCode: number, errorMsg: string): void {
  sendJson(res, httpStatus, { error_code: errorCode, error_msg: errorMsg } satisfies DifyErrorBody);
}

/** Constant-time comparison — same rationale as the Gateway's safeEqual. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ============================
// DifyMemoryAdapter
// ============================

export class DifyMemoryAdapter extends BasePlatformAdapter {
  readonly platformName = "dify";

  private readonly port: number;
  private readonly host: string;
  private readonly apiKey?: string;
  private readonly defaultSessionKey: string;
  private server?: http.Server;

  constructor(opts: DifyMemoryAdapterOptions) {
    super({ client: opts.client, logger: opts.logger });
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? DEFAULT_HOST;
    const trimmedKey = opts.apiKey?.trim();
    this.apiKey = trimmedKey ? trimmedKey : undefined;
    this.defaultSessionKey = opts.defaultSessionKey ?? DEFAULT_SESSION_KEY;
  }

  /** Actual bound port once started (needed by tests that pass port 0). */
  get boundPort(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? (addr as AddressInfo).port : undefined;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => resolve());
      this.server!.on("error", reject);
    });

    this.logger.info(`${TAG} Dify adapter listening on http://${this.host}:${this.boundPort}`);
    if (!this.apiKey) {
      this.logger.warn(
        `${TAG} TDAI_DIFY_API_KEY is NOT set — /retrieval and /tools/* are open to anyone who can ` +
        `reach this port. Set an API key and configure the same value in the Dify console before ` +
        `exposing the adapter beyond the loopback interface.`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    await super.stop(); // closes this.client
  }

  // ============================
  // Router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0];

    try {
      // Open routes — health probes and tool-spec import need no auth.
      if (method === "GET" && pathname === "/health") {
        return await this.handleHealth(res);
      }
      if (method === "GET" && pathname === "/openapi.json") {
        return this.handleOpenApi(req, res);
      }

      if (!this.checkAuth(req, res)) return;

      switch (`${method} ${pathname}`) {
        case "POST /retrieval":
          return await this.handleRetrieval(req, res);
        case "POST /tools/capture":
          return await this.handleToolCapture(req, res);
        case "POST /tools/recall":
          return await this.handleToolRecall(req, res);
        default:
          difyError(res, 404, 2001, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof InvalidJsonBodyError) {
        // Client fault, not an engine failure — answer 400 like the other
        // request-validation errors instead of a misleading 500.
        this.logger.warn(`${TAG} Bad request [${method} ${pathname}]: ${msg}`);
        if (!res.headersSent) difyError(res, 400, 4000, msg);
        return;
      }
      this.logger.error(`${TAG} Request error [${method} ${pathname}]: ${msg}`);
      if (!res.headersSent) {
        difyError(res, 500, 5000, msg);
      }
    }
  }

  // ============================
  // Auth (Dify error-code semantics)
  // ============================

  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.apiKey) return true; // open mode — warned at startup

    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      difyError(
        res, 403, 1001,
        "Invalid Authorization header format. Expected 'Bearer <api-key>' format.",
      );
      return false;
    }
    const provided = header.slice("Bearer ".length).trim();
    if (!provided || !safeEqual(provided, this.apiKey)) {
      difyError(res, 403, 1002, "Authorization failed");
      return false;
    }
    return true;
  }

  // ============================
  // POST /retrieval — Dify External Knowledge Base API
  // ============================

  private async handleRetrieval(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<DifyRetrievalRequest>(req);

    if (!body.query || typeof body.query !== "string") {
      difyError(res, 400, 4000, "Missing required field: query");
      return;
    }
    if (!body.knowledge_id || typeof body.knowledge_id !== "string") {
      difyError(res, 400, 4000, "Missing required field: knowledge_id");
      return;
    }

    // Liberal defaults when retrieval_setting is absent/partial.
    const rawTopK = body.retrieval_setting?.top_k;
    const topK = Math.min(Math.max(Number(rawTopK) || DEFAULT_TOP_K, 1), MAX_TOP_K);
    const rawThreshold = Number(body.retrieval_setting?.score_threshold);
    const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 0;

    let records: DifyRetrievalRecord[];
    switch (body.knowledge_id) {
      case KNOWLEDGE_ID_MEMORIES: {
        const outcome = await this.client.searchMemories({ query: body.query, limit: topK });
        records = outcome.items.map((item) => ({
          content: item.content,
          score: item.score,
          title: item.scene_name || item.type,
          metadata: {
            id: item.id,
            type: item.type,
            scene_name: item.scene_name,
            created_at: item.created_at,
          },
        }));
        // Fallback for backends without structured items (older gateways):
        // surface the formatted text as a single record so retrieval still works.
        if (records.length === 0 && outcome.total > 0) {
          records = [{ content: outcome.text, score: 1, title: "tdai-memories" }];
        }
        break;
      }
      case KNOWLEDGE_ID_CONVERSATIONS: {
        const outcome = await this.client.searchConversations({ query: body.query, limit: topK });
        records = outcome.items.map((item) => ({
          content: item.content,
          score: item.score,
          title: `${item.role}@${item.session_key}`,
          metadata: {
            id: item.id,
            role: item.role,
            session_key: item.session_key,
            recorded_at: item.recorded_at,
          },
        }));
        if (records.length === 0 && outcome.total > 0) {
          records = [{ content: outcome.text, score: 1, title: "tdai-conversations" }];
        }
        break;
      }
      default:
        difyError(res, 404, 2001, "The knowledge does not exist");
        return;
    }

    // Engine scores are raw ranking values — under the default hybrid
    // strategy they are RRF sums capped near 2/61 ≈ 0.033 — while Dify's
    // score_threshold assumes 0..1 relevance, so any realistic threshold
    // would silently drop every record. Normalize per batch (divide by the
    // batch max; order-preserving, top hit = 1.0) so the threshold acts as
    // a relative cutoff within the batch.
    const maxScore = records.reduce((max, r) => Math.max(max, r.score), 0);
    if (maxScore > 0) {
      records = records.map((r) => ({ ...r, score: r.score / maxScore }));
    }
    const filtered = records.filter((r) => r.score >= threshold);
    this.logger.debug?.(
      `${TAG} /retrieval knowledge_id=${body.knowledge_id} top_k=${topK} ` +
      `threshold=${threshold} → ${filtered.length}/${records.length} records`,
    );
    sendJson(res, 200, { records: filtered } satisfies DifyRetrievalResponse);
  }

  // ============================
  // POST /tools/capture — memory WRITE path (Dify Custom Tool)
  // ============================

  private async handleToolCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<DifyCaptureToolRequest>(req);

    if (!body.user_content || !body.assistant_content) {
      difyError(res, 400, 4000, "Missing required fields: user_content, assistant_content");
      return;
    }

    const outcome = await this.client.capture({
      userContent: body.user_content,
      assistantContent: body.assistant_content,
      sessionKey: body.session_key?.trim() || this.defaultSessionKey,
      sessionId: body.session_id,
    });

    sendJson(res, 200, {
      l0_recorded: outcome.l0Recorded,
      scheduler_notified: outcome.schedulerNotified,
    } satisfies DifyCaptureToolResponse);
  }

  // ============================
  // POST /tools/recall — context prefetch (Dify Custom Tool)
  // ============================

  private async handleToolRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<DifyRecallToolRequest>(req);

    if (!body.query) {
      difyError(res, 400, 4000, "Missing required field: query");
      return;
    }

    const outcome = await this.client.recall({
      query: body.query,
      sessionKey: body.session_key?.trim() || this.defaultSessionKey,
    });

    sendJson(res, 200, {
      context: outcome.context,
      strategy: outcome.strategy,
      memory_count: outcome.memoryCount,
    } satisfies DifyRecallToolResponse);
  }

  // ============================
  // GET /openapi.json + GET /health
  // ============================

  private handleOpenApi(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Advertise the URL the caller actually reached us on, so a spec imported
    // from a LAN/tunnel address points Dify back at the same address.
    const hostHeader = req.headers.host ?? `${this.host}:${this.boundPort}`;
    sendJson(res, 200, buildOpenApiSpec(`http://${hostHeader}`));
  }

  /** Never throws — reports upstream reachability instead. */
  private async handleHealth(res: http.ServerResponse): Promise<void> {
    let upstream: unknown = "unreachable";
    try {
      upstream = await this.client.health();
    } catch {
      // keep "unreachable"
    }
    sendJson(res, 200, { status: "ok", platform: "dify", upstream });
  }
}
