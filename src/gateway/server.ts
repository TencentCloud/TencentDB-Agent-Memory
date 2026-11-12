/**
 * TDAI Gateway — HTTP server for the Hermes sidecar.
 *
 * Exposes TDAI Core capabilities as HTTP endpoints:
 *   GET  /health              — Health check
 *   POST /recall              — Memory recall (prefetch)
 *   POST /capture             — Conversation capture (sync_turn)
 *   POST /search/memories     — L1 memory search
 *   POST /search/conversations — L0 conversation search
 *   POST /session/end         — Session end + flush
 *   POST /seed               — Batch seed historical conversations (L0 → L1)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { TdaiCore } from "../core/tdai-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { initDataDirectories, resetStores } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import { resolveUserIdRouting } from "../utils/user-id.js";
import type {
  HealthResponse,
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  SeedRequest,
  SeedResponse,
  GatewayErrorResponse,
} from "./types.js";
import type { Logger } from "../core/types.js";
import { validateAndNormalizeRaw, fillTimestamps, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";

/**
 * Maximum number of simultaneously-live per-user cores. When exceeded, the
 * least-recently-used core is evicted (WARN + background destroy). Eviction
 * only reclaims in-memory handles — the `users/<uid>/` data on disk is kept,
 * so a later request for the same user transparently re-creates the core.
 */
const MAX_USER_CORES = 64;

/** Hard timeout for per-user `core.destroy()` — a stuck destroy (e.g. a hung
 *  in-flight embed call being drained) must not block eviction or shutdown. */
const USER_CORE_DESTROY_TIMEOUT_MS = 2000;

/** A lazily-created per-user core. */
interface UserCoreEntry {
  core: TdaiCore;
  /** Shared `initialize()` promise — deduplicates concurrent first requests. */
  ready: Promise<void>;
  /** LRU clock, bumped on every `getCoreForUser` hit. */
  lastAccess: number;
}

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${TAG} ${msg}`),
    info: (msg: string) => console.info(`${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

// ============================
// Request body parser
// ============================

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
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

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

/**
 * Constant-time string equality for secrets.
 *
 * Returns `false` on any length mismatch (without comparing bytes), and uses
 * `crypto.timingSafeEqual` for the equal-length case so that an attacker
 * probing the API key cannot use response timing to learn a prefix match.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ============================
// Gateway Server
// ============================

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();
  /** Per-user cores (multi-user routing) — keyed by normalized uid. */
  private userCores = new Map<string, UserCoreEntry>();

  constructor(configOverrides?: Partial<GatewayConfig>) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core
    this.core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
    });
  }

  // ============================
  // Multi-user core routing
  // ============================

  /**
   * Resolve which core instance serves a request, from the raw `user_id`
   * field. Delegates the decision to {@link resolveUserIdRouting}:
   *
   *   1. multi-user disabled / invalid uid / owner / "default" → main core
   *   2. otherwise (normalized uid)                            → per-user core
   *
   * For per-user cores the shared `initialize()` promise is awaited before
   * the core is handed out: TdaiCore's search methods do NOT wait for store
   * readiness internally (recall/capture/session-end do), so a user's first
   * request being a search would otherwise race store initialization and
   * degrade to empty results. On init failure the core still degrades
   * gracefully (empty searches, captures fall back to JSONL).
   *
   * Invalid-or-missing uids additionally emit a normalization-rejection WARN
   * (monitored; the gradual-rollout exit criterion is a count of zero).
   * The raw value is never logged verbatim — only its type/length — to keep
   * junk input out of the logs.
   */
  private async _resolveCore(rawUserId: unknown): Promise<TdaiCore> {
    const routing = resolveUserIdRouting(
      {
        multiUserEnabled: this.config.multiUser.enabled,
        ownerUserIds: this.config.multiUser.ownerUserIds,
      },
      rawUserId,
    );

    if (routing.warn) {
      this.logger.warn(
        `Invalid or missing user_id (type=${typeof rawUserId}, ` +
        `length=${typeof rawUserId === "string" ? rawUserId.length : 0}) — ` +
        "routing to main store (fail-closed)",
      );
    }

    if (routing.pool === "user" && routing.uid) {
      const entry = this.getCoreForUser(routing.uid);
      // Concurrent first requests share one initialization (promise dedup).
      await entry.ready.catch(() => {});
      return entry.core;
    }
    // The main core is initialized in start() before the HTTP server accepts
    // requests, so it needs no readiness await here.
    return this.core;
  }

  /** Per-user data directory: `<baseDir>/users/<uid>/`. */
  private userCoreDataDir(uid: string): string {
    // uid is validated (`^[a-z0-9_-]{1,64}$`), so this path cannot traverse.
    return path.join(this.config.data.baseDir, "users", uid);
  }

  /**
   * Get (lazily creating) the per-user core entry for a normalized uid.
   * Returns the entry (core + shared `initialize()` promise) rather than the
   * bare core so callers can await readiness — see {@link _resolveCore}.
   *
   * Each user gets its own `StandaloneHostAdapter` + `TdaiCore` rooted at
   * {@link userCoreDataDir} — `initStores` caches per dataDir, so a distinct
   * directory yields a fully isolated memory stack (vectors.db, L0 jsonl,
   * persona, scene blocks, checkpoints). Concurrent first requests for the
   * same uid share one initialization via the Map entry (promise dedup).
   */
  private getCoreForUser(uid: string): UserCoreEntry {
    const existing = this.userCores.get(uid);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing;
    }

    const dataDir = this.userCoreDataDir(uid);
    const adapter = new StandaloneHostAdapter({
      dataDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });
    const core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
    });

    const entry: UserCoreEntry = { core, ready: core.initialize(), lastAccess: Date.now() };
    this.userCores.set(uid, entry);
    this.logger.info(`User core created [uid=${uid}] dataDir=${dataDir} (${this.userCores.size}/${MAX_USER_CORES})`);

    // Store-level init failures are swallowed inside TdaiCore (degraded mode:
    // empty searches, captures fall back to JSONL) and the entry is KEPT —
    // the promise only rejects on unexpected errors (e.g. unwritable
    // dataDir), in which case the entry is dropped so the next request
    // retries cleanly.
    entry.ready.catch((err) => {
      this.logger.error(`User core init failed [uid=${uid}]: ${err instanceof Error ? err.message : String(err)}`);
      if (this.userCores.get(uid) === entry) this.userCores.delete(uid);
    });

    this.evictUserCoresIfNeeded();
    return entry;
  }

  /**
   * LRU eviction: while more than {@link MAX_USER_CORES} cores are live,
   * destroy the one with the oldest `lastAccess`. Destroy runs in the
   * background (raced against {@link USER_CORE_DESTROY_TIMEOUT_MS}) so a
   * stuck destroy never blocks request handling; eviction persists
   * checkpoints and keeps the on-disk data.
   *
   * Before starting the background destroy, the shared store-init cache
   * entry for the evicted user's dataDir is dropped **synchronously**
   * (`resetStores`). `TdaiCore.destroy()` only clears that cache at its
   * very end — doing it only there would leave a window (the destroy
   * drain period) in which a same-uid request creates a fresh core whose
   * `initialize()` hits the cached init promise and silently inherits
   * store handles the in-flight destroy is about to close.
   */
  private evictUserCoresIfNeeded(): void {
    while (this.userCores.size > MAX_USER_CORES) {
      let oldestUid: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [uid, entry] of this.userCores) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestUid = uid;
        }
      }
      if (oldestUid === undefined) break;

      const evicted = this.userCores.get(oldestUid)!;
      this.userCores.delete(oldestUid);
      // Synchronously close the rebuild window — must happen BEFORE the
      // background destroy starts (see docstring above).
      resetStores(this.userCoreDataDir(oldestUid));
      this.logger.warn(
        `User core LRU evicted [uid=${oldestUid}] — userCores=${this.userCores.size}/${MAX_USER_CORES}; ` +
        `destroying in background (${USER_CORE_DESTROY_TIMEOUT_MS}ms timeout); on-disk data kept`,
      );
      this.destroyUserCore(oldestUid, evicted);
    }
  }

  /**
   * Destroy a per-user core, racing against a hard timeout. Fire-and-forget
   * safe: a destroy failure is logged as a WARN (the on-disk data and the
   * next request's fresh core absorb it) and then swallowed so it can never
   * produce an unhandled rejection.
   */
  private destroyUserCore(uid: string, entry: UserCoreEntry): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, USER_CORE_DESTROY_TIMEOUT_MS);
      timeoutId.unref?.();
    });
    return Promise.race([entry.core.destroy(), timeout])
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      })
      .catch((err) => {
        this.logger.warn(
          `User core destroy failed [uid=${uid}]: ${err instanceof Error ? err.message : String(err)} ` +
          "(on-disk data kept; a later request re-creates the core)",
        );
      });
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    // Initialize core
    await this.core.initialize();

    if (this.config.multiUser.enabled) {
      this.logger.info(
        `Multi-user routing ENABLED: owners=${this.config.multiUser.ownerUserIds.length}, ` +
        `maxUserCores=${MAX_USER_CORES}, layout=<baseDir>/users/<uid>/`,
      );
    }

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    const { port, host } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port}`);
        this.logSecurityPosture();
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Emit a one-shot security posture summary at startup.
   *
   * Goals:
   *   1. Make the "auth disabled" state highly visible to anyone reading logs
   *      (this is the documented default, but operators must know it before
   *      they expose the port).
   *   2. Loudly warn when the gateway is bound to anything other than the
   *      loopback interface without an API key — that exact combination is
   *      what the security audit flagged as a real exposure.
   *   3. Never log the key itself.
   */
  private logSecurityPosture(): void {
    const { host, apiKey, corsOrigins } = this.config.server;
    const authOn = !!apiKey;
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

    this.logger.info(
      `Security posture: auth=${authOn ? "ENABLED (Bearer)" : "disabled"} ` +
      `host=${host} cors=${corsOrigins.length === 0 ? "no-headers" : corsOrigins.includes("*") ? "wildcard(*)" : `allowlist(${corsOrigins.length})`}`
    );

    if (!authOn) {
      this.logger.warn(
        "TDAI_GATEWAY_API_KEY is NOT set — all routes except GET /health are " +
        "open to anyone who can reach this port. This is the legacy default. " +
        "Set TDAI_GATEWAY_API_KEY (or server.apiKey in tdai-gateway.yaml) and " +
        "pass `Authorization: Bearer <key>` from clients before exposing the " +
        "gateway beyond the loopback interface."
      );
    }
    if (!loopback && !authOn) {
      this.logger.warn(
        `Gateway is bound to ${host} (non-loopback) WITHOUT an API key. ` +
        "Every /capture, /search/conversations, /recall, /seed call from the " +
        "network is currently unauthenticated. Bind to 127.0.0.1, or set " +
        "TDAI_GATEWAY_API_KEY, before continuing."
      );
    }
    if (corsOrigins.includes("*")) {
      this.logger.warn(
        "CORS allow-list contains '*' — every browser origin can call this " +
        "gateway. Restrict server.corsOrigins to a concrete allow-list for any " +
        "non-local deployment."
      );
    }
  }

  /**
   * Gracefully stop the Gateway.
   */
  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    // Tear down per-user cores first (each destroy raced with a hard timeout
    // so one stuck user store cannot hang the shutdown).
    if (this.userCores.size > 0) {
      await Promise.allSettled(
        [...this.userCores.entries()].map(([uid, entry]) => this.destroyUserCore(uid, entry)),
      );
      this.userCores.clear();
    }

    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    // Apply CORS headers based on configured allow-list (empty → no headers).
    this.applyCorsHeaders(req, res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // GET /health is always reachable without auth — operators and
      // orchestrators (k8s liveness, docker health-check) rely on it being
      // an unconditionally cheap probe.
      if (method === "GET" && pathname === "/health") {
        return this.handleHealth(res);
      }

      // All other routes go through the optional auth gate. When apiKey is
      // unset the gate is a no-op (preserves legacy open behaviour) — the
      // startup WARN in `logSecurityPosture` covers that case.
      if (!this.checkAuth(req, res)) return;

      switch (`${method} ${pathname}`) {
        case "POST /recall":
          return await this.handleRecall(req, res);
        case "POST /capture":
          return await this.handleCapture(req, res);
        case "POST /search/memories":
          return await this.handleSearchMemories(req, res);
        case "POST /search/conversations":
          return await this.handleSearchConversations(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Request error [${method} ${pathname}]: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  // ============================
  // Auth & CORS gates (opt-in, off by default)
  // ============================

  /**
   * Verify the `Authorization: Bearer <apiKey>` header against the configured
   * shared secret using a constant-time comparison.
   *
   * When `server.apiKey` is unset (`undefined`), this returns `true` without
   * inspecting the request — this is the documented default and matches the
   * pre-existing open behaviour. Operators are reminded of this at startup
   * via `logSecurityPosture`.
   *
   * Returns `false` (and writes 401) when the token is missing, malformed, or
   * does not match. Callers must short-circuit on `false`.
   */
  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const expected = this.config.server.apiKey;
    if (!expected) return true; // auth disabled — default behaviour

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

  /**
   * Echo `Access-Control-Allow-Origin` (and friends) only for whitelisted
   * origins. With no list configured we emit no CORS headers at all, which
   * makes the browser refuse the cross-origin request as desired.
   *
   * The single-entry list `["*"]` opts back into permissive CORS (development
   * use only; the startup log flags this loudly).
   */
  private applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const allow = this.config.server.corsOrigins ?? [];
    if (allow.length === 0) return; // strict default — no headers

    if (allow.includes("*")) {
      // Wildcard — preserves the legacy permissive behaviour for callers that
      // opt in explicitly via config. Note: with wildcard we deliberately do
      // not echo back the request Origin and do not send `Vary: Origin`,
      // mirroring how the gateway behaved before this change.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return;
    }

    const requestOrigin = req.headers["origin"];
    if (typeof requestOrigin !== "string" || !allow.includes(requestOrigin)) {
      // Origin not in allow-list — emit no CORS headers; browser will block.
      // Always set Vary so caches don't poison responses across origins.
      res.setHeader("Vary", "Origin");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }

  // ============================
  // Route handlers
  // ============================

  private handleHealth(res: http.ServerResponse): void {
    const response: HealthResponse = {
      status: this.core.getVectorStore() ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: !!this.core.getVectorStore(),
        embeddingService: !!this.core.getEmbeddingService(),
      },
    };
    sendJson(res, 200, response);
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    const startMs = Date.now();
    const core = await this._resolveCore(body.user_id);
    const result = await core.handleBeforeRecall(body.query, body.session_key);
    const elapsed = Date.now() - startMs;

    this.logger.info(`Recall completed in ${elapsed}ms: context=${(result.appendSystemContext?.length ?? 0)} chars`);

    const response: RecallResponse = {
      context: result.appendSystemContext ?? "",
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    const startMs = Date.now();
    const core = await this._resolveCore(body.user_id);
    const result = await core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(`Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`);

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const core = await this._resolveCore(body.user_id);
    const result = await core.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
    });

    const response: MemorySearchResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const core = await this._resolveCore(body.user_id);
    const result = await core.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
    });

    const response: ConversationSearchResponse = {
      results: result.text,
      total: result.total,
    };
    sendJson(res, 200, response);
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    const core = await this._resolveCore(body.user_id);
    await core.handleSessionEnd(body.session_key);

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    // Multi-user guard: /seed ALWAYS writes to the MAIN store. While
    // multi-user routing is enabled, refuse seeds addressed to a regular
    // per-user store — history seeded into the shared pool would be readable
    // by the admin but invisible to the teacher it belongs to. Note: the
    // gateway has no *per-user* authentication (the shared optional Bearer
    // key authenticates the client, not which user is calling), so `user_id`
    // is caller-declared; this 403 guards against misuse, not forgery.
    const seedRouting = resolveUserIdRouting(
      {
        multiUserEnabled: this.config.multiUser.enabled,
        ownerUserIds: this.config.multiUser.ownerUserIds,
      },
      body.user_id,
    );
    if (seedRouting.pool === "user" && seedRouting.uid) {
      sendJson(res, 403, { error: "seed is not allowed for per-user stores" } satisfies GatewayErrorResponse);
      return;
    }

    // Validate and normalize input (reuses seed CLI's validation layers 2-6)
    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
    );

    // Resolve output directory: use gateway's data dir with a timestamped subfolder
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    // Merge config overrides if provided
    // Start with the base memory config + inject llm config from gateway settings
    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: {
        enabled: true,
        baseUrl: this.config.llm.baseUrl,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        timeoutMs: this.config.llm.timeoutMs,
        disableThinking: this.config.llm.disableThinking,
      },
    };
    if (body.config_override) {
      for (const key of Object.keys(body.config_override)) {
        const baseVal = pluginConfig[key];
        const overVal = body.config_override[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
            overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    // Execute seed pipeline (blocking — this may take minutes for large inputs)
    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      logger: this.logger as import("../utils/pipeline-factory.js").PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }
}

// ============================
// CLI entry point
// ============================

/**
 * Start the gateway from the command line.
 * Usage: node --import tsx src/gateway/server.ts
 */
async function main(): Promise<void> {
  const gateway = new TdaiGateway();

  // Graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
