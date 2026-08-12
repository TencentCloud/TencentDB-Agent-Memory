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
import { URL } from "node:url";
import { TdaiCore } from "../core/tdai-core.js";
import {
  createDevLogger,
  isDevMode,
  logFileUnderRoot,
} from "../utils/dev-logger.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig, GatewayConfigOverrides } from "./config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import type {
  HealthResponse,
  StatusResponse,
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
} from "./types.js";
import type { Logger } from "../core/types.js";
import {
  validateAndNormalizeRaw,
  fillTimestamps,
  SeedValidationError,
} from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";
import {
  parseJsonBody,
  parseJsonBodyOptional,
  sendJson,
  sendError,
  safeEqual,
  openReadonlySqlite,
} from "./http-utils.js";
import { LoopbackTokenManager } from "./token.js";
import { checkWriteAuth as isMemoryWriteAuthed } from "./write-auth.js";
import {
  handleMemoryInfo,
  handleMemoryRecords,
  handleMemoryDuplicates,
  handleMemoryBlocks,
  handleMemoryValidate,
  type MemoryRoutesContext,
} from "./memory-routes.js";
import { handleMemoryApply, type ApplyRouteContext } from "./apply-executor.js";
import {
  handleMemorySearch,
  handleMemoryNote,
  type MemoryToolsContext,
} from "./memory-tools.js";
import {
  handleMemoryFeedback,
  type FeedbackRouteContext,
  type RecallEventSummary,
} from "./feedback.js";
import { buildRoleDefaults } from "./role-defaults.js";
import { ConsolidationOrchestrator } from "./consolidation/orchestrator.js";
import { createCounterObserver } from "./consolidation/layer-counters.js";
import { withProvenance } from "../core/record/provenance-observer.js";
import {
  drainCommitObserver,
  setCommitObserver,
} from "../core/record/commit-port.js";
import { NightRunTimer } from "./consolidation/night-run.js";
import {
  countNewL0Since,
  cursorOfCheckpoint,
} from "./consolidation/diff-builder.js";
import { listRoles, resolveRoleDirForRead } from "./role-files.js";
import { allowLegacyFallback, resolveUnderRoot } from "./tdai-root.js";
import { hostTaskRoots } from "./consolidation/launchers/auth-root.js";
import {
  listRoleContracts,
  roleScratchRoots,
} from "./consolidation/role-contract.js";
import { deprecationNotice } from "./consolidation/launchers/pi-config.js";
import { CleanupTimer, runCleanup } from "./cleanup.js";
import { listRecentRuns } from "./control-plane/run-repo.js";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";
/** How many recall events stay linkable by `recall_id` (tz-04 C4). */
const RECENT_RECALLS_MAX = 200;

// ============================
// Dev logger (for standalone gateway): console + file sink; debug only in dev mode.
// The actual logger is created in the constructor from config.logging.
// ============================

// ============================
// Gateway Server
// ============================

/** Clients are untrusted: accept a string, cap its length, everything else is "unknown project". */
function sanitizeProjectId(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, 512) : "";
}

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();
  /** Loopback memory token manager (write-gate credential for /memory/* routes). */
  private tokenManager: LoopbackTokenManager;
  /** Consolidation orchestrator (wave tdai-memory-subagents-2026-08-02, P6). */
  private orchestrator: ConsolidationOrchestrator;
  /** Night-run timer (P7): schedule + threshold + catch-up inside the gateway. */
  private nightRun: NightRunTimer;
  /** Workspace cleanup timer (P11a): age-based removal of run artifacts. */
  private cleanupTimer: CleanupTimer;

  // ============================
  // Diagnostic counters and last-event snapshots for /status
  // (added 2026-07-24; see the tdai-memory-health plan of that day)
  // ============================
  private counterRecalls = 0;
  private counterCaptures = 0;
  private counterSessionEnds = 0;
  private counterSearchMemories = 0;
  private counterSearchConversations = 0;
  private counterSeeds = 0;
  private counterErrors = 0;
  private lastRecall: StatusResponse["lastRecall"] = null;
  /**
   * Recent recall events by id (tz-04 C4). Bounded and in-memory on purpose:
   * this links a feedback to the turn it came from, it is not an audit log.
   */
  private readonly recentRecalls = new Map<string, RecallEventSummary>();
  private lastCapture: StatusResponse["lastCapture"] = null;
  private lastError: StatusResponse["lastError"] = null;
  private totalsStale = true;

  constructor(configOverrides?: GatewayConfigOverrides) {
    this.config = loadGatewayConfig(configOverrides);
    // tz-07 H2, criterion 3: ONLY a default-rooted install may still read
    // roles/prompts left at the pre-tz-07 location. An explicit root is a
    // deliberate relocation — and it is what every sandbox and test uses, so
    // declaring those too let them read the operator's real install.
    if (this.config.data.baseDirIsDefault) {
      allowLegacyFallback(this.config.data.baseDir);
    }
    // Dev logger: file sink from config.logging.file, debug from yaml level
    // OR TDAI_DEV=1 (env wins — see dev-logger.isDevMode).
    // tz-07 H1: logDir follows baseDir, so an unset logging.file cannot resolve
    // logs from the DEFAULT root while everything else follows the named one.
    // A CONFIGURED absolute file is filtered the same way (logFileUnderRoot):
    // the cwd config is read by every process started in this directory, and a
    // named root must not write into somebody else's tree.
    const logDir = resolveUnderRoot(this.config.data.baseDir, "logs");
    const logChoice = logFileUnderRoot({
      logDir,
      configuredFile: this.config.logging.file,
      rootIsDefault: this.config.data.baseDirIsDefault,
    });
    this.logger = createDevLogger({
      tag: TAG,
      dev: this.config.logging.level === "debug" || isDevMode(),
      logFile: logChoice.file,
      logDir,
    });
    if (logChoice.refused !== null) {
      this.logger.warn(
        `${TAG} logging.file "${logChoice.refused}" is outside this install's ` +
          `root — writing to ${logChoice.file} instead`,
      );
    }
    this.tokenManager = new LoopbackTokenManager(
      this.config.data.baseDir,
      this.logger,
    );

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
      sessionFilter: new SessionFilter(
        this.config.memory.capture.excludeAgents,
      ),
    });

    // Consolidation orchestrator + night-run timer (P6/P7). Created here so
    // stop()/shutdown can always kill an in-flight keeper child group. Store
    // accessors are lazy — the vector store initializes in core.initialize().
    // Scratch root comes from the instance config (tz-02 критерий 2) — the
    // spawn side below and the cleanup sweep further down must name the SAME
    // directory, so neither of them derives it. Its default is a SIBLING of
    // dataDir, OUTSIDE the memory tree (ТЗ §5.1: cwd = scratch-dir вне дерева
    // памяти) — a relative-path escape from the child cwd (../persona.md)
    // cannot reach real memory files.
    const gatewayUrl = `http://${this.config.server.host}:${this.config.server.port}`;
    // Composition root of the role path (tz-01 criterion 7): the global
    // consolidation knobs are read HERE, once, and handed to the orchestrator
    // as an explicit snapshot. Nothing under consolidation/ reads them —
    // role parameters come from the resolved contract, and the snapshot is
    // only what the LegacyRoleAdapter may fall back to for a legacy role.
    const consolidationCfg = this.config.memory.consolidation;
    // tz-06 Ф1: legacy launcher keys keep working, but silently — an operator
    // whose config still names the old keys has no way to learn they moved.
    const notice = deprecationNotice(consolidationCfg.deprecatedLauncherKeys);
    if (notice !== "") this.logger.warn?.(`[config] ${notice}`);
    this.orchestrator = new ConsolidationOrchestrator({
      config: this.config,
      enabled: consolidationCfg.enabled,
      roleDefaults: buildRoleDefaults(consolidationCfg),
      applyGateMode: consolidationCfg.applyGateMode,
      applyRunRepo: consolidationCfg.applyRunRepo,
      launchers: consolidationCfg.launchers,
      dataDir: this.config.data.baseDir,
      scratchRoot: this.config.data.scratchRoot,
      logger: this.logger,
      gatewayUrl,
      vectorStore: () => this.core.getVectorStore(),
      embeddingService: () => this.core.getEmbeddingService(),
    });
    this.nightRun = new NightRunTimer({
      enabled: this.config.memory.consolidation.enabled,
      timezone: this.config.memory.timezone,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
      // Which roles are due comes from their contracts, not from
      // memory.nightRun.schedule/threshold (tz-01 B6): those stay only as the
      // legacy snapshot the adapter falls back to.
      listRoleContracts: () =>
        listRoleContracts(
          resolveRoleDirForRead(this.config.data.baseDir),
          buildRoleDefaults(consolidationCfg),
        ),
      readCheckpoint: () => this.orchestrator.readCheckpoint(),
      legacyDispatch: consolidationCfg.contractDispatch
        ? undefined
        : {
            schedule: this.config.memory.nightRun.schedule,
            threshold: this.config.memory.nightRun.threshold,
            scheduleRole: this.config.memory.nightRun.scheduleRole,
            thresholdRole: this.config.memory.nightRun.thresholdRole,
          },
      countNewL0: async () => {
        const cp = await this.orchestrator.readCheckpoint();
        // Same composite predicate as the run path (run-role.ts): a status
        // that counted by bare timestamp would disagree with the run on every
        // row sitting exactly on the boundary — the common case, not the rare
        // one.
        return countNewL0Since(
          nodePath.join(this.config.data.baseDir, "vectors.db"),
          cursorOfCheckpoint(cp),
        );
      },
      trigger: async (reason: string, runType?: string) =>
        this.orchestrator.trigger({ reason, runType }),
      // Threshold refused while the night window holds the gate → re-arm the
      // deferred day retry until it is ACCEPTED (the night window can hold the
      // Per-role gate up to maxRunMs=90min; a one-shot +5min retry would hit busy
      // again and silently drop the crossing). Backoff: 5min → 10min → 20min.
      onThresholdDeferred: () => {
        let attempt = 0;
        const delays = [5 * 60_000, 10 * 60_000, 20 * 60_000];
        const arm = (): void => {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          attempt += 1;
          setTimeout(() => {
            void this.orchestrator
              .trigger({ reason: "threshold-deferred" })
              .then((res) => {
                if (!res.accepted && res.status === "busy") arm(); // night still holds gate
              });
          }, delay);
        };
        arm();
      },
      logger: this.logger,
    });

    // Workspace cleanup (P11a): run artifacts (logs/diffs/reports/backups/stale
    // scratch + the child tasks subtree) on memory.cleanup.intervalHours.
    this.cleanupTimer = new CleanupTimer({
      enabled: this.config.memory.cleanup.enabled,
      intervalHours: this.config.memory.cleanup.intervalHours,
      run: () =>
        runCleanup({
          dataDir: this.config.data.baseDir,
          scratchRoot: this.config.data.scratchRoot,
          // Per-role roots (tz-02 Ф5): with `keep_scratch` an attempt dir
          // outlives its run, so this pass is the only thing that ever deletes
          // it — and a role with its own `runtime.scratch_root` is not under
          // the instance root at all. Read at each pass, not at boot: roles
          // are edited on disk while the gateway runs.
          extraScratchRoots: roleScratchRoots(
            buildRoleDefaults(consolidationCfg),
            resolveRoleDirForRead(this.config.data.baseDir),
          ),
          // tz-07 H3/Q2: the host's own task tree is the host's business, so
          // the caller resolves it per launcher and cleanup stays
          // launcher-agnostic. claude/codex contribute nothing — their
          // per-attempt artifacts already live under scratch.
          sessionRetentionHours: consolidationCfg.sessionRetentionHours,
          hostTaskRoots: hostTaskRoots(
            Object.keys(consolidationCfg.launchers ?? {}),
          ),
          home: process.env.HOME ?? "/tmp",
          config: this.config.memory.cleanup,
          now: () => Date.now(),
          logger: this.logger,
        }),
      now: () => Date.now(),
      logger: this.logger,
    });
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    // Ensure the loopback token file exists (0600, outside dataDir) before
    // serving — the pi extension discovers it via GET /memory/info.
    this.tokenManager.ensure();

    // Initialize core
    await this.core.initialize();

    // tz-03b: the commit port gets its one subscriber here, after the store
    // exists. Without this call every notifyCommitted() is a no-op and the
    // counters never move — which is exactly the package's rollback path.
    // The store is passed as a SUPPLIER: a degraded init leaves it undefined
    // here, and the mutating routes stay open — the scene counter needs no
    // store at all, and l1Count starts moving as soon as one exists.
    // tz-05: provenance composes with the counters instead of claiming a
    // second slot — it stamps the carriers first, then the counters recompute
    // from the already-stamped tree.
    setCommitObserver(
      withProvenance(
        createCounterObserver(
          this.config.data.baseDir,
          () => this.core.getVectorStore(),
          this.logger,
        ),
        this.config.data.baseDir,
        this.logger,
      ),
      this.logger,
    );

    // Consolidation: restore checkpoint, sweep stale keepers, catch-up check.
    await this.orchestrator.start();
    this.nightRun.start();
    this.cleanupTimer.start();

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
    const loopback =
      host === "127.0.0.1" || host === "localhost" || host === "::1";

    this.logger.info(
      `Security posture: auth=${authOn ? "ENABLED (Bearer)" : "disabled"} ` +
        `host=${host} cors=${corsOrigins.length === 0 ? "no-headers" : corsOrigins.includes("*") ? "wildcard(*)" : `allowlist(${corsOrigins.length})`}`,
    );

    if (!authOn) {
      this.logger.warn(
        "TDAI_GATEWAY_API_KEY is NOT set — all routes except GET /health are " +
          "open to anyone who can reach this port. This is the legacy default. " +
          "Set TDAI_GATEWAY_API_KEY (or server.apiKey in tdai-gateway.yaml) and " +
          "pass `Authorization: Bearer <key>` from clients before exposing the " +
          "gateway beyond the loopback interface.",
      );
    }
    if (!loopback && !authOn) {
      this.logger.warn(
        `Gateway is bound to ${host} (non-loopback) WITHOUT an API key. ` +
          "Every /capture, /search/conversations, /recall, /seed call from the " +
          "network is currently unauthenticated. Bind to 127.0.0.1, or set " +
          "TDAI_GATEWAY_API_KEY, before continuing.",
      );
    }
    if (corsOrigins.includes("*")) {
      this.logger.warn(
        "CORS allow-list contains '*' — every browser origin can call this " +
          "gateway. Restrict server.corsOrigins to a concrete allow-list for any " +
          "non-local deployment.",
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

    this.nightRun.stop();
    this.cleanupTimer.stop();
    await this.orchestrator.stop();

    // The commit port never awaits its observer, so a mutation from the last
    // request can still be writing its checkpoint here. Draining before the
    // store closes is what keeps that counter instead of dropping it.
    await drainCommitObserver();
    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
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

      // GET /status — auth-free diagnostic snapshot (same posture as /health):
      // counters + totals + REDACTED lastError, the consolidation block (P6)
      // and the control-plane runs (tz-09). One handler: this path used to be
      // claimed twice, and the second (documented, richer) branch was dead.
      if (method === "GET" && pathname === "/status") {
        return this.handleStatus(res);
      }

      // GET /memory/* — memory read routes + discovery, auth-free on loopback
      // (same posture as /status). Read-only; never exposes secrets.
      if (method === "GET" && pathname.startsWith("/memory/")) {
        return await this.handleMemoryRead(req, res, pathname);
      }

      // Memory write routes — dedicated write-gate: EITHER `Authorization:
      // Bearer <apiKey>` OR `x-memory-token` (alternative credentials, NOT
      // stacked on top of checkAuth below). POST /memory/apply is implemented
      // by the P4 ApplyExecutor (apply-executor.ts); POST /memory/run lands in
      // the P6 orchestrator batch and stays reserved here.
      if (method === "POST" && pathname === "/memory/apply") {
        if (!this.checkMemoryWriteAuth(req, res)) return;
        const t0 = performance.now();
        this.logger.debug?.("[route] POST /memory/apply start");
        await this.handleMemoryApply(req, res);
        this.logger.info(
          `[route] POST /memory/apply done in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return;
      }
      if (method === "POST" && pathname === "/memory/run") {
        if (!this.checkMemoryWriteAuth(req, res)) return;
        const t0 = performance.now();
        const dry = url.searchParams.get("dry");
        this.logger.debug?.(`[route] POST /memory/run start dry=${dry ?? "0"}`);
        await this.handleMemoryRun(req, res, url);
        this.logger.info(
          `[route] POST /memory/run done in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return;
      }

      // Memory feedback loop (#4): the pi extension bumps recall priority with
      // raw 80-char dedup keys. Write route (same gate as /memory/apply).
      if (method === "POST" && pathname === "/memory/feedback") {
        if (!this.checkMemoryWriteAuth(req, res)) return;
        const t0 = performance.now();
        this.logger.debug?.("[route] POST /memory/feedback start");
        await this.handleMemoryFeedback(req, res);
        this.logger.info(
          `[route] POST /memory/feedback done in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return;
      }

      // Memory tools for the main agent (#12): POST /memory/note records an
      // L0 note into L1 extraction. Write route (same gate).
      if (method === "POST" && pathname === "/memory/note") {
        if (!this.checkMemoryWriteAuth(req, res)) return;
        const t0 = performance.now();
        this.logger.debug?.("[route] POST /memory/note start");
        await this.handleMemoryNote(req, res);
        this.logger.info(
          `[route] POST /memory/note done in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return;
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
      this.recordError(`${method} ${pathname}`, err);
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
  private checkAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
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
   * Write-gate for memory mutation routes (wave tdai-memory-subagents-2026-08-02).
   *
   * Accepts EITHER `Authorization: Bearer <apiKey>` OR `x-memory-token` —
   * alternative credentials, NOT stacked on top of checkAuth. The loopback
   * token always exists (generated at startup), so memory write routes are
   * never open even when no server.apiKey is configured. Constant-time
   * compare; 401 on missing/mismatch.
   */
  private checkMemoryWriteAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    const token = this.tokenManager.ensure();
    if (isMemoryWriteAuthed(req.headers, this.config.server.apiKey, token))
      return true;
    sendError(res, 401, "Unauthorized: missing or invalid memory token");
    return false;
  }

  /**
   * Auth-free loopback dispatch for GET /memory/* (read routes + discovery).
   * Handlers live in memory-routes.ts; they only read the store and memory
   * tree (INVARIANT nogo-records-rewrite) and never expose credentials.
   */
  private async handleMemoryRead(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const ctx: MemoryRoutesContext = {
      core: this.core,
      config: this.config,
      tokenManager: this.tokenManager,
      logger: this.logger,
      version: VERSION,
    };
    switch (pathname) {
      case "/memory/info":
        return handleMemoryInfo(ctx, res);
      case "/memory/records":
        return await handleMemoryRecords(ctx, url, res);
      case "/memory/duplicates":
        return await handleMemoryDuplicates(ctx, url, res);
      case "/memory/blocks":
        return await handleMemoryBlocks(ctx, url, res);
      case "/memory/validate":
        return await handleMemoryValidate(ctx, url, res);
      case "/memory/search":
        return await this.handleMemorySearch(ctx, url, res);
      default:
        sendError(res, 404, `Not found: GET ${pathname}`);
    }
  }

  /**
   * POST /memory/apply — apply a memory-keeper diff through the ApplyExecutor
   * (P4, apply-executor.ts). The write-gate already ran; this method only
   * builds the route context and delegates. Content-Type enforcement and
   * status mapping live in the handler.
   */
  private async handleMemoryApply(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const ctx: ApplyRouteContext = {
      core: this.core,
      config: this.config,
      logger: this.logger,
    };
    return await handleMemoryApply(ctx, req, res);
  }

  /**
   * POST /memory/run — manual consolidation trigger (P6). Asynchronous: 202 +
   * status immediately; the run proceeds in the background under single-flight
   * (timer / threshold / manual / catch-up never overlap). `?dry=1` → dry-run
   * (builds the diff, touches nothing). Fail-open (критерий 21): answers 202
   * with a status even when consolidation is disabled or a spawn would fail.
   */
  private async handleMemoryRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const dryRun = url.searchParams.get("dry") === "1";
    let body: { role?: unknown } | null;
    try {
      body = await parseJsonBodyOptional<{ role?: unknown }>(req);
    } catch {
      sendError(res, 400, "Invalid JSON body");
      return;
    }
    // A named role must be honoured or refused — never silently swapped for
    // the default one: the caller would get a Run for another role and no
    // sign that its parameter was dropped.
    const requested = body?.role;
    if (requested !== undefined && typeof requested !== "string") {
      sendError(res, 400, "role must be a string");
      return;
    }
    if (requested !== undefined) {
      // The registry /status shows is the one a run may name.
      const known = listRoles(this.config.data.baseDir).find(
        (r) => r.name === requested,
      );
      if (!known) {
        sendError(res, 400, `unknown role "${requested}"`);
        return;
      }
      if (!known.enabled) {
        sendError(res, 409, `role "${requested}" is disabled`);
        return;
      }
    }
    const result = await this.orchestrator.trigger({
      reason: "manual",
      dryRun,
      runType: requested,
    });
    sendJson(res, 202, {
      accepted: result.accepted,
      status: result.status,
      dryRun,
      role: requested ?? null,
      reason: result.reason,
      runId: result.runId ?? null,
    });
  }

  /**
   * GET /memory/search — memory_search tool for the main agent (#12).
   * Auth-free loopback (same posture as /status). Reuses the tdai_memory_search
   * machinery via TdaiCore.
   */
  private async handleMemorySearch(
    ctx: MemoryRoutesContext,
    url: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const toolsCtx: MemoryToolsContext = {
      core: this.core,
      logger: this.logger,
    };
    return await handleMemorySearch(toolsCtx, url, res);
  }

  /**
   * POST /memory/note — memory_note tool for the main agent (#12). Writes an
   * L0 note through the existing capture path (write-gate already ran).
   */
  private async handleMemoryNote(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const toolsCtx: MemoryToolsContext = {
      core: this.core,
      logger: this.logger,
    };
    return await handleMemoryNote(toolsCtx, req, res);
  }

  /**
   * POST /memory/feedback — agent feedback loop (#4). The write-gate already
   * ran; the handler bumps L1 priorities for the received 80-char keys.
   */
  private async handleMemoryFeedback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const feedbackCtx: FeedbackRouteContext = {
      dataDir: this.config.data.baseDir,
      logger: this.logger,
      findRecallEvent: (recallId) => this.recentRecalls.get(recallId),
    };
    return await handleMemoryFeedback(feedbackCtx, req, res);
  }

  /**
   * reindex-in-progress gate (ТЗ §5.6): true while a full reindex is running.
   * The vector store fails OPEN (empty result) — the route-level check below
   * covers the FTS/keyword fallback paths too, so /recall and the search
   * routes return an empty result as a whole, never an error.
   */
  private reindexGateOn(): boolean {
    return this.core.getVectorStore()?.isReindexing?.() ?? false;
  }

  /**
   * Echo `Access-Control-Allow-Origin` (and friends) only for whitelisted
   * origins. With no list configured we emit no CORS headers at all, which
   * makes the browser refuse the cross-origin request as desired.
   *
   * The single-entry list `["*"]` opts back into permissive CORS (development
   * use only; the startup log flags this loudly).
   */
  private applyCorsHeaders(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const allow = this.config.server.corsOrigins ?? [];
    if (allow.length === 0) return; // strict default — no headers

    if (allow.includes("*")) {
      // Wildcard — preserves the legacy permissive behaviour for callers that
      // opt in explicitly via config. Note: with wildcard we deliberately do
      // not echo back the request Origin and do not send `Vary: Origin`,
      // mirroring how the gateway behaved before this change.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
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
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
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

  /**
   * Collect DB-level totals (l0 messages, l1 records, scene blocks).
   * Uses bun:sqlite (gateway runs under bun per systemd unit).
   * On any failure, sets totals.stale=true and returns last-known zeros;
   * a DB-read failure does NOT flip overall service status — that is
   * derived from vectorStore+embeddingService only.
   */
  private collectTotals(): StatusResponse["totals"] {
    const sceneDir = nodePath.join(this.config.data.baseDir, "scene_blocks");
    // Blocks are nested one level down per project (scene_blocks/<slug>/*.md).
    const dbPath = nodePath.join(this.config.data.baseDir, "vectors.db");
    let l0 = 0;
    let l1 = 0;
    let scene = 0;
    let ok = true;
    try {
      const db = openReadonlySqlite(dbPath);
      try {
        const r0 = db
          .prepare("SELECT count(*) AS c FROM l0_conversations")
          .get() as { c: number } | null;
        const r1 = db.prepare("SELECT count(*) AS c FROM l1_records").get() as {
          c: number;
        } | null;
        l0 = r0?.c ?? 0;
        l1 = r1?.c ?? 0;
      } finally {
        db.close();
      }
    } catch {
      ok = false;
    }
    try {
      scene = nodeFs
        .readdirSync(sceneDir, { recursive: true })
        .filter((f) => String(f).endsWith(".md")).length;
    } catch {
      ok = false;
    }
    this.totalsStale = !ok;
    return { l0Messages: l0, l1Records: l1, sceneBlocks: scene, stale: !ok };
  }

  /**
   * Record a routing/handler error in /status.lastError with category
   * classification and ≤120-char message redaction.
   */
  private recordError(source: string, err: unknown): void {
    this.counterErrors++;
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 120 ? raw.slice(0, 117) + "..." : raw;
    const category = /SeedValidation|invalid/i.test(raw)
      ? "validation"
      : /vec|store|sqlite|database/i.test(raw)
        ? "store"
        : /embed|llm|api/i.test(raw)
          ? "embedding"
          : "internal";
    this.lastError = {
      at: new Date().toISOString(),
      source,
      category,
      message,
    };
  }

  /**
   * /status — diagnostic extension of /health with traffic counters and
   * last-event snapshots. Lives on the same auth-free /status path;
   * returns REDACTED lastError (≤ 120 chars) and category enum.
   */
  private handleStatus(res: http.ServerResponse): void {
    // Collect totals FIRST; status is derived from vectorStore+embeddingService
    // ONLY — totals.stale is an independent flag.
    const totals = this.collectTotals();
    const vectorOk = !!this.core.getVectorStore();
    const embeddingOk = !!this.core.getEmbeddingService();
    const response: StatusResponse = {
      status: vectorOk && embeddingOk ? "ok" : "degraded",
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - this.startTime) / 1000),
      startedAt: new Date(this.startTime).toISOString(),
      dataPath: this.config.data.baseDir,
      vectorStore: vectorOk,
      embeddingService: embeddingOk,
      totals,
      counters: {
        recalls: this.counterRecalls,
        captures: this.counterCaptures,
        sessionEnds: this.counterSessionEnds,
        searchMemories: this.counterSearchMemories,
        searchConversations: this.counterSearchConversations,
        seeds: this.counterSeeds,
        errors: this.counterErrors,
      },
      lastRecall: this.lastRecall,
      lastCapture: this.lastCapture,
      lastError: this.lastError,
      consolidation: {
        enabled: this.config.memory.consolidation.enabled,
        checkpoint: this.orchestrator.checkpointFile,
        inFlight: this.orchestrator.isRunning,
        lastRun: this.orchestrator.getLastRun(),
      },
      roles: listRoles(this.config.data.baseDir),
      reindexInProgress: this.core.getVectorStore()?.isReindexing?.() ?? false,
      runs: this.recentRuns(),
    };
    sendJson(res, 200, response);
  }

  /** Control-plane projection for /status (tz-09 Ф1). Fails soft: an absent
   * or unreadable control plane yields [], never a 500 on a diagnostic route. */
  private recentRuns(): StatusResponse["runs"] {
    try {
      return listRecentRuns(this.config.data.baseDir).map((r) => ({
        runId: r.runId,
        role: r.roleId,
        state: r.state,
        fence: r.fence,
        startedAt: r.createdAt,
        errorClass: r.errorClass,
        logPath: r.logPath,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Register a recall event and return its id. The map is capped by dropping
   * the oldest entry — a long-running gateway must not grow a map per turn.
   */
  private rememberRecall(sessionKey: string, count: number): string {
    const event: RecallEventSummary = {
      recallId: randomUUID(),
      at: new Date().toISOString(),
      sessionKey,
      count,
    };
    this.recentRecalls.set(event.recallId, event);
    if (this.recentRecalls.size > RECENT_RECALLS_MAX) {
      const oldest = this.recentRecalls.keys().next().value;
      if (oldest !== undefined) this.recentRecalls.delete(oldest);
    }
    return event.recallId;
  }

  private async handleRecall(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    // reindex-in-progress gate (ТЗ §5.6): during a full reindex return an
    // EMPTY result, never an error (fail-open).
    if (this.reindexGateOn()) {
      this.logger.info?.(
        "[tdai-gateway] /recall gate: full reindex in progress — returning empty (fail-open)",
      );
      sendJson(res, 200, {
        context: "",
        strategy: "gated",
        memory_count: 0,
        // The gate answered instead of the pipeline, so this id names a real
        // recall event that returned nothing — feedback on it is still
        // meaningful ("I asked and got nothing").
        recall_id: this.rememberRecall(body.session_key, 0),
      } satisfies RecallResponse);
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(
      body.query,
      body.session_key,
      sanitizeProjectId(body.project_id),
      body.include_persona !== false,
    );
    const elapsed = Date.now() - startMs;

    this.logger.info(
      `Recall completed in ${elapsed}ms: context=${result.appendSystemContext?.length ?? 0} chars`,
    );

    // /status snapshot — truncated query (≤256) + sha256[:16] hash for safe monitoring.
    this.counterRecalls++;
    const q = body.query;
    const truncated = q.length > 256 ? q.slice(0, 253) + "..." : q;
    const qhash = createHash("sha256").update(q).digest("hex").slice(0, 16);
    const recallId = this.rememberRecall(
      body.session_key,
      result.recalledL1Memories?.length ?? 0,
    );
    this.lastRecall = {
      at: new Date().toISOString(),
      recallId,
      query: truncated,
      queryHash: qhash,
      sessionKey: body.session_key,
      latencyMs: elapsed,
      count: result.recalledL1Memories?.length ?? 0,
    };

    const response: RecallResponse = {
      context: [result.prependContext, result.appendSystemContext]
        .filter(Boolean)
        .join("\n\n"),
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
      recall_id: recallId,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(
        res,
        400,
        "Missing required fields: user_content, assistant_content, session_key",
      );
      return;
    }

    const startMs = Date.now();
    let result;
    try {
      result = await this.core.handleTurnCommitted({
        userText: body.user_content,
        assistantText: body.assistant_content,
        messages: body.messages ?? [
          { role: "user", content: body.user_content },
          { role: "assistant", content: body.assistant_content },
        ],
        sessionKey: body.session_key,
        sessionId: body.session_id,
        projectId: sanitizeProjectId(body.project_id),
      });
    } catch (err) {
      this.recordError("POST /capture", err);
      this.lastCapture = {
        at: new Date().toISOString(),
        sessionKey: body.session_key,
        latencyMs: Date.now() - startMs,
        status: "failed",
      };
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, msg);
      return;
    }
    const elapsed = Date.now() - startMs;

    this.logger.info(
      `Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`,
    );

    // /status snapshot — success path.
    this.counterCaptures++;
    this.lastCapture = {
      at: new Date().toISOString(),
      sessionKey: body.session_key,
      latencyMs: elapsed,
      status: "ok",
    };

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    // reindex-in-progress gate (ТЗ §5.6): empty result, not an error.
    if (this.reindexGateOn()) {
      this.logger.info?.(
        "[tdai-gateway] /search/memories gate: full reindex in progress — returning empty (fail-open)",
      );
      sendJson(res, 200, {
        results: "",
        total: 0,
        strategy: "gated",
      } satisfies MemorySearchResponse);
      return;
    }

    this.counterSearchMemories++;

    const result = await this.core.searchMemories({
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

  private async handleSearchConversations(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    // reindex-in-progress gate (ТЗ §5.6): empty result, not an error.
    if (this.reindexGateOn()) {
      this.logger.info?.(
        "[tdai-gateway] /search/conversations gate: full reindex in progress — returning empty (fail-open)",
      );
      sendJson(res, 200, {
        results: "",
        total: 0,
      } satisfies ConversationSearchResponse);
      return;
    }

    this.counterSearchConversations++;

    const result = await this.core.searchConversations({
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

  private async handleSessionEnd(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.handleSessionEnd(body.session_key);

    this.counterSessionEnds++;

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
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
        this.recordError("POST /seed", err);
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
        if (
          baseVal &&
          typeof baseVal === "object" &&
          !Array.isArray(baseVal) &&
          overVal &&
          typeof overVal === "object" &&
          !Array.isArray(overVal)
        ) {
          pluginConfig[key] = {
            ...(baseVal as Record<string, unknown>),
            ...(overVal as Record<string, unknown>),
          };
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
      logger: this
        .logger as import("../utils/pipeline-factory.js").PipelineLogger,
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

    // /status snapshot — seed success.
    this.counterSeeds++;

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
const isMain =
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
