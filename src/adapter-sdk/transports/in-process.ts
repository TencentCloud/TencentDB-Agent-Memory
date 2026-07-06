/**
 * Adapter SDK — In-process transport.
 *
 * `InProcessMemoryClient` wraps a `TdaiCore` instance living in the same Node
 * process — no HTTP hop, no sidecar. Two construction modes:
 *
 *   1. **Injected core** (`opts.core`): the host already owns a core (or a
 *      test injects a fake `TdaiCoreLike`). The client delegates calls and
 *      does NOT manage the core's lifecycle — `close()` leaves it running.
 *
 *   2. **Owned core** (no `opts.core`): the client lazily builds a standalone
 *      core on first use, from the same `loadGatewayConfig()` machinery the
 *      Gateway uses (env vars `TDAI_DATA_DIR`, `TDAI_LLM_*`, config file
 *      `tdai-gateway.yaml`). `close()` destroys it.
 *
 * The method → core mapping is intentionally identical to what
 * `src/gateway/server.ts` does for the Hermes provider, so the two transports
 * are semantically interchangeable behind `MemoryClient`.
 */

import type { Logger, CompletedTurn } from "../../core/types.js";
import type {
  MemoryClient,
  TdaiCoreLike,
  RecallParams,
  RecallOutcome,
  CaptureParams,
  CaptureOutcome,
  SearchMemoriesParams,
  SearchMemoriesOutcome,
  SearchConversationsParams,
  SearchConversationsOutcome,
  HealthOutcome,
} from "../types.js";
import { MemoryClientError } from "../errors.js";

const TAG = "[tdai-adapter] [in-process]";

// ============================
// Options
// ============================

export interface InProcessMemoryClientOptions {
  /**
   * Pre-built core (dependency injection). When provided, the client never
   * initializes or destroys it — the owner keeps the lifecycle.
   */
  core?: TdaiCoreLike;
  /**
   * Overrides forwarded to `loadGatewayConfig()` when the client builds its
   * own core (ignored when `core` is injected). Same shape as the Gateway's
   * `Partial<GatewayConfig>` — kept loose here to avoid a hard config import
   * in the common injected-core path.
   */
  gatewayConfigOverrides?: Record<string, unknown>;
  logger?: Logger;
}

function defaultLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${TAG} ${msg}`),
    info: (msg: string) => console.info(`${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

// ============================
// InProcessMemoryClient
// ============================

export class InProcessMemoryClient implements MemoryClient {
  private core?: TdaiCoreLike;
  /** True only when this client constructed the core itself. */
  private ownsCore = false;
  private readonly gatewayConfigOverrides?: Record<string, unknown>;
  private readonly logger: Logger;
  /**
   * Gate for the one-shot lazy build (same pattern as TdaiCore's
   * `ensureSchedulerStarted`): concurrent first calls all await the same
   * in-flight promise, so exactly one core is ever built/initialized.
   */
  private corePromise?: Promise<TdaiCoreLike>;
  private closed = false;

  constructor(opts: InProcessMemoryClientOptions = {}) {
    this.logger = opts.logger ?? defaultLogger();
    this.gatewayConfigOverrides = opts.gatewayConfigOverrides;
    if (opts.core) {
      this.core = opts.core;
      this.corePromise = Promise.resolve(opts.core);
      this.ownsCore = false;
    }
  }

  // ============================
  // MemoryClient implementation
  // ============================

  async recall(params: RecallParams): Promise<RecallOutcome> {
    const core = await this.ensureCore();
    const result = await this.wrap("recall", () =>
      core.handleBeforeRecall(params.query, params.sessionKey),
    );
    // Same projection the Gateway applies in handleRecall().
    return {
      context: result.appendSystemContext ?? "",
      prependContext: result.prependContext,
      strategy: result.recallStrategy,
      memoryCount: result.recalledL1Memories?.length ?? 0,
    };
  }

  async capture(params: CaptureParams): Promise<CaptureOutcome> {
    const core = await this.ensureCore();
    // Same CompletedTurn construction as the Gateway's handleCapture().
    const turn: CompletedTurn = {
      userText: params.userContent,
      assistantText: params.assistantContent,
      messages: params.messages ?? [
        { role: "user", content: params.userContent },
        { role: "assistant", content: params.assistantContent },
      ],
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    };
    const result = await this.wrap("capture", () => core.handleTurnCommitted(turn));
    return {
      l0Recorded: result.l0RecordedCount,
      schedulerNotified: result.schedulerNotified,
    };
  }

  async searchMemories(params: SearchMemoriesParams): Promise<SearchMemoriesOutcome> {
    const core = await this.ensureCore();
    // Prefer the structured variant (items + text) when the core provides it;
    // fall back to the text-only facade for older/minimal cores.
    if (core.searchMemoriesStructured) {
      const structured = await this.wrap("searchMemories", () =>
        core.searchMemoriesStructured!(params),
      );
      const { formatSearchResponse } = await import("../../core/tools/memory-search.js");
      return {
        text: formatSearchResponse(structured),
        total: structured.total,
        strategy: structured.strategy,
        items: structured.results,
      };
    }
    const result = await this.wrap("searchMemories", () => core.searchMemories(params));
    return { text: result.text, total: result.total, strategy: result.strategy, items: [] };
  }

  async searchConversations(params: SearchConversationsParams): Promise<SearchConversationsOutcome> {
    const core = await this.ensureCore();
    if (core.searchConversationsStructured) {
      const structured = await this.wrap("searchConversations", () =>
        core.searchConversationsStructured!(params),
      );
      const { formatConversationSearchResponse } = await import(
        "../../core/tools/conversation-search.js"
      );
      return {
        text: formatConversationSearchResponse(structured),
        total: structured.total,
        items: structured.results,
      };
    }
    const result = await this.wrap("searchConversations", () => core.searchConversations(params));
    return { text: result.text, total: result.total, items: [] };
  }

  async endSession(sessionKey: string): Promise<void> {
    const core = await this.ensureCore();
    await this.wrap("endSession", () => core.handleSessionEnd(sessionKey));
  }

  async health(): Promise<HealthOutcome> {
    const core = await this.ensureCore();
    // Same derivation as the Gateway's /health handler.
    const vectorStore = !!core.getVectorStore();
    const embeddingService = !!core.getEmbeddingService();
    return {
      status: vectorStore ? "ok" : "degraded",
      vectorStore,
      embeddingService,
    };
  }

  /** Destroys the core only when this client built it (owned lifecycle). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // An owned-core build may still be in flight — await it so the core it
    // produces is destroyed instead of leaked (sqlite handles, scheduler).
    // Injected cores resolve immediately and stay untouched below.
    if (!this.core && this.corePromise) {
      await this.corePromise.catch(() => undefined);
    }
    if (this.ownsCore && this.core) {
      await this.core.destroy();
      this.core = undefined;
      this.corePromise = undefined;
    }
  }

  // ============================
  // Lazy core construction
  // ============================

  private ensureCore(): Promise<TdaiCoreLike> {
    if (this.closed) {
      return Promise.reject(
        new MemoryClientError("unavailable", "InProcessMemoryClient is closed"),
      );
    }
    if (this.corePromise) return this.corePromise;

    this.corePromise = this.buildOwnedCore();
    // Clear the gate on failure so a later call can retry the build.
    this.corePromise.catch(() => {
      this.corePromise = undefined;
    });
    return this.corePromise;
  }

  /**
   * Build a standalone TdaiCore from Gateway config (env + optional yaml).
   *
   * Dynamic imports keep the heavy store/pipeline modules out of the module
   * graph for the injected-core path (tests, embedding hosts) — mirroring how
   * the Gateway itself constructs its core in `TdaiGateway`'s constructor.
   * Concrete module paths are imported (never `src/adapters/index.ts`) so the
   * SDK stays loadable without the optional `openclaw` peer dependency.
   */
  private async buildOwnedCore(): Promise<TdaiCoreLike> {
    const [{ loadGatewayConfig }, { StandaloneHostAdapter }, { TdaiCore }, pipelineFactory, { SessionFilter }] =
      await Promise.all([
        import("../../gateway/config.js"),
        import("../../adapters/standalone/host-adapter.js"),
        import("../../core/tdai-core.js"),
        import("../../utils/pipeline-factory.js"),
        import("../../utils/session-filter.js"),
      ]);

    const cfg = loadGatewayConfig(this.gatewayConfigOverrides as never);
    const hostAdapter = new StandaloneHostAdapter({
      dataDir: cfg.data.baseDir,
      llmConfig: cfg.llm,
      logger: this.logger,
      platform: "adapter-sdk",
    });
    const core = new TdaiCore({
      hostAdapter,
      config: cfg.memory,
      sessionFilter: new SessionFilter(cfg.memory.capture.excludeAgents),
    });

    pipelineFactory.initDataDirectories(cfg.data.baseDir);
    await core.initialize();

    this.core = core;
    this.ownsCore = true;
    this.logger.info(`${TAG} Owned TdaiCore initialized (dataDir=${cfg.data.baseDir})`);
    return core;
  }

  // ============================
  // Error normalization
  // ============================

  private async wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MemoryClientError) throw err;
      const message = `Core ${op} failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(`${TAG} ${message}`);
      throw new MemoryClientError("transport", message, { cause: err });
    }
  }
}
