/**
 * TdaiCore — Host-neutral facade for TDAI memory capabilities.
 *
 * This is the single entry point that both OpenClaw and Hermes/Gateway call
 * to perform recall, capture, search, and pipeline management. It depends
 * only on abstract interfaces (HostAdapter, LLMRunner), never on a specific host.
 *
 * Usage:
 *   // OpenClaw path (in-process)
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   const recall = await core.handleBeforeRecall("user query", "session-1");
 *
 *   // Gateway path (HTTP)
 *   const adapter = new StandaloneHostAdapter({ ... });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   // HTTP handler calls core.handleBeforeRecall / core.handleTurnCommitted / etc.
 */

import type {
  HostAdapter,
  Logger,
  LLMRunnerFactory,
  RecallResult,
  CaptureResult,
  CompletedTurn,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore } from "./store/types.js";
import type { EmbeddingService } from "./store/embedding.js";
import { StorageAdapter, type StorageAdapter } from "./storage/adapter.js";
import { LocalStorageBackend } from "./storage/local-backend.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import { reportRecallMetrics } from "./report/metric-tracking-recall.js";
import { performAutoCapture } from "./hooks/auto-capture.js";
import { executeMemorySearch, formatSearchResponse } from "./tools/memory-search.js";
import { executeConversationSearch, formatConversationSearchResponse } from "./tools/conversation-search.js";
import {
  initDataDirectories,
  initStores,
  resetStores,
  createPipelineManager,
  createL1Runner,
  createPersister,
  createL2Runner,
  createL3Runner,
} from "../utils/pipeline-factory.js";
import { MemoryPipelineManager } from "../utils/pipeline-manager.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import { SessionFilter } from "../utils/session-filter.js";
import { StandaloneLLMRunnerFactory } from "../adapters/standalone/llm-runner.js";
import { MetricTrackingRunnerFactory } from "./report/metric-tracking-runner.js";

const TAG = "[memory-tdai] [core]";

// ============================
// Constructor options
// ============================

export interface TdaiCoreOptions {
  /** Host adapter providing runtime context, logger, and LLM runner factory. */
  hostAdapter: HostAdapter;
  /** Parsed TDAI memory configuration. */
  config: MemoryTdaiConfig;
  /** Session filter for excluding internal/benchmark sessions. */
  sessionFilter?: SessionFilter;
  /** Plugin instance ID for metric reporting. */
  instanceId?: string;
  /** StorageAdapter for file operations (COS/local). When absent, modules fall back to fs. */
  storage?: StorageAdapter;
}

// ============================
// TdaiCore
// ============================

export class TdaiCore {
  private hostAdapter: HostAdapter;
  private cfg: MemoryTdaiConfig;
  private logger: Logger;
  private dataDir: string;
  private runnerFactory: LLMRunnerFactory;
  private sessionFilter: SessionFilter;
  private instanceId?: string;
  private storage?: StorageAdapter;

  // Lazy-initialized resources
  private vectorStore?: IMemoryStore;
  private embeddingService?: EmbeddingService;
  private scheduler?: MemoryPipelineManager;
  /**
   * Promise gate for the one-shot scheduler-start sequence.
   *
   * ``ensureSchedulerStarted`` reads a checkpoint file (async) and then
   * calls ``scheduler.start(restoredStates)``.  Under the Gateway, several
   * HTTP requests can reach ``handleTurnCommitted`` concurrently and all
   * race into that function.  Using a plain boolean flag is unsafe: the
   * first caller flips the flag to ``true`` *before* the await completes,
   * so subsequent callers slip past the check and touch the scheduler
   * before ``start()`` has actually run — which makes ``start()``'s
   * ``sessionStates.set(key, restored)`` later clobber the state that
   * those concurrent captures already incremented.
   *
   * Storing the in-flight promise lets every concurrent caller ``await``
   * the same start sequence.  Once it resolves the promise is kept as a
   * sentinel so subsequent calls are a single already-resolved await
   * (effectively a no-op).
   */
  private schedulerStartPromise?: Promise<void>;
  private storeReady?: Promise<void>;

  /**
   * In-flight fire-and-forget background tasks started by
   * ``handleTurnCommitted`` (currently: deferred L0 embedding for
   * SQLite-style stores — see auto-capture.ts path A).
   *
   * ``destroy()`` awaits all pending entries (with a hard timeout)
   * before closing ``vectorStore`` / ``embeddingService`` so that a
   * late ``updateL0Embedding`` cannot land on an already-closed
   * database connection.
   *
   * Each task registers itself on creation and removes itself in its
   * own ``finally`` handler, so the set stays bounded by the number
   * of currently-running background tasks.
   */
  private readonly bgTasks = new Set<Promise<void>>();

  constructor(opts: TdaiCoreOptions) {
    this.hostAdapter = opts.hostAdapter;
    this.cfg = opts.config;
    this.logger = opts.hostAdapter.getLogger();
    this.dataDir = opts.hostAdapter.getRuntimeContext().dataDir;
    this.runnerFactory = opts.hostAdapter.getLLMRunnerFactory();
    this.sessionFilter = opts.sessionFilter ?? new SessionFilter([]);
    this.instanceId = opts.instanceId;
    // CR-2 (2026-05-19): the l1-writer CR-2 guard expects every writeMemory call
    // to be backed by a StorageAdapter. In service mode the caller passes one
    // (e.g. CosStorageBackend). In standalone mode (the typical install on a
    // single host) the caller usually omits it, expecting the gateway to
    // auto-wire a LocalStorageBackend. That auto-wire was documented in
    // l1-writer.ts:202-217 ("server.ts:199-203") but is missing in this build
    // for the OpenClaw host-adapter entry. We restore the auto-wire here so
    // standalone installs stop emitting the CR-2 guard warning, while
    // service-mode callers that pass a custom storage still win.
    this.storage = opts.storage ?? new StorageAdapter(new LocalStorageBackend({ rootDir: this.dataDir, logger: this.logger }));
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Initialize data directories, storage, and pipeline scheduler.
   * Must be called once before any other methods.
   */
  async initialize(): Promise<void> {
    this.logger.debug?.(`${TAG} Initializing TDAI Core: dataDir=${this.dataDir}`);
    initDataDirectories(this.dataDir);

    // Initialize stores (async)
    this.storeReady = this.initStores();

    // Create pipeline manager (sync — does not need store)
    if (this.cfg.extraction.enabled) {
      this.scheduler = createPipelineManager(this.cfg, this.logger, this.sessionFilter);
      // Wire runners after store is ready (or after store init fails — runners
      // still work in degraded mode with JSONL fallback and no embedding)
      this.storeReady
        .then(() => this.wirePipelineRunners())
        .catch((err) => {
          this.logger.error(`${TAG} Store init failed; wiring pipeline runners in degraded mode: ${err instanceof Error ? err.message : String(err)}`);
          this.wirePipelineRunners();
        });
    }

    this.logger.debug?.(`${TAG} TDAI Core initialized`);
  }

  /**
   * Destroy all resources. Call on shutdown.
   */
  async destroy(): Promise<void> {
    this.logger.debug?.(`${TAG} Destroying TDAI Core...`);

    // Wait for store init to complete before tearing down
    await this.storeReady?.catch(() => {});

    if (this.scheduler && this.schedulerStartPromise) {
      await this.scheduler.destroy();
      this.schedulerStartPromise = undefined;
      this.logger.debug?.(`${TAG} Scheduler destroyed`);
    }

    // Drain fire-and-forget background tasks started by auto-capture
    // (currently: deferred L0 embedding writes).  We must wait for
    // them here — BEFORE closing vectorStore / embeddingService —
    // otherwise a late updateL0Embedding lands on an already-closed
    // DB connection and either throws "database is not open" or
    // (worse) corrupts state.  A hard timeout keeps destroy bounded
    // when a background task is stuck on a hung embed HTTP call.
    if (this.bgTasks.size > 0) {
      const pending = [...this.bgTasks];
      this.logger.debug?.(
        `${TAG} Draining ${pending.length} background task(s) before closing stores...`,
      );
      const BG_DRAIN_TIMEOUT_MS = 5_000;
      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          new Promise<never>((_, reject) => {
            drainTimeoutId = setTimeout(
              () => reject(new Error("bgTasks drain timeout")),
              BG_DRAIN_TIMEOUT_MS,
            );
          }),
        ]);
        this.logger.debug?.(`${TAG} Background tasks drained`);
      } catch (err) {
        this.logger.warn(
          `${TAG} Background-task drain timed out (${BG_DRAIN_TIMEOUT_MS}ms): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Closing stores anyway — residual writes may surface as warnings.`,
        );
      } finally {
        if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);
      }
    }

    if (this.vectorStore) {
      this.vectorStore.close();
      this.vectorStore = undefined;
      this.logger.debug?.(`${TAG} VectorStore closed`);
    }

    if (this.embeddingService?.close) {
      try {
        await this.embeddingService.close();
      } catch (err) {
        this.logger.warn(`${TAG} EmbeddingService close error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.embeddingService = undefined;
    }

    resetStores(this.dataDir);
    this.logger.debug?.(`${TAG} TDAI Core destroyed`);
  }

  // ============================
  // Core capabilities
  // ============================

  /**
   * Handle recall (memory retrieval) before an LLM turn.
   * Maps to: OpenClaw `before_prompt_build` / Hermes `prefetch()`.
   */
  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    await this.storeReady?.catch(() => {});

    const tStart = performance.now();
    const result = await performAutoRecall({
      userText,
      actorId: "default_user",
      sessionKey,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      storage: this.storage,
    });
    const recallLatencyMs = performance.now() - tStart;

    // 非侵入式上报召回指标（静默失败，绝不影响业务返回）
    try {
      const recallResult = result ?? {};
      reportRecallMetrics({
        instanceId: this.instanceId ?? "",
        recalledL1Memories: recallResult.recalledL1Memories,
        recallStrategy: recallResult.recallStrategy ?? "skipped",
        recallLatencyMs,
        hasError: !!recallResult.error,
      });
    } catch {
      // 静默失败
    }

    return result ?? {};
  }

  /**
   * Handle turn commitment (conversation capture + pipeline trigger).
   * Maps to: OpenClaw `agent_end` / Hermes `sync_turn()`.
   */
  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    await this.storeReady?.catch(() => {});
    await this.ensureSchedulerStarted();

    return performAutoCapture({
      messages: turn.messages,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      scheduler: this.scheduler,
      originalUserText: turn.userText,
      originalUserMessageCount: turn.originalUserMessageCount,
      pluginStartTimestamp: turn.startedAt ?? Date.now(),
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      bgTaskRegistry: this.bgTasks,
      storage: this.storage,
    });
  }

  /**
   * Search L1 structured memories.
   * Maps to: `tdai_memory_search` tool.
   */
  async searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    const result = await executeMemorySearch({
      query: params.query,
      limit: params.limit ?? 5,
      type: params.type,
      scene: params.scene,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatSearchResponse(result),
      total: result.total,
      strategy: result.strategy,
    };
  }

  /**
   * Search L0 raw conversations.
   * Maps to: `tdai_conversation_search` tool.
   */
  async searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }> {
    const result = await executeConversationSearch({
      query: params.query,
      limit: params.limit ?? 5,
      sessionKey: params.sessionKey,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatConversationSearchResponse(result),
      total: result.total,
    };
  }

  /**
   * Handle end-of-conversation for a single session.
   *
   * ⚠️ Read this if you are editing the method:
   *
   * There are two distinct shutdown-ish events, and they must **NOT**
   * share an implementation:
   *
   *   - **`gateway_stop` (OpenClaw / process exit)**
   *     The host is going away.  Tear everything down — scheduler,
   *     VectorStore, EmbeddingService, caches.  That is
   *     {@link destroy}, not this method.
   *
   *   - **`on_session_end` (Hermes) / `POST /session/end` (Gateway)**
   *     One conversation ended while the process keeps serving other
   *     concurrent sessions.  **Only** this session's buffered work
   *     should be flushed; every other session's timers, buffers,
   *     pipeline state, and the shared scheduler itself MUST remain
   *     untouched.  That is this method.
   *
   * Historically this method did ``scheduler.destroy() +
   * createPipelineManager()``, which conflated the two semantics and
   * wiped concurrent sessions' in-memory state on every ``/session/end``
   * call.  That bug is covered by the concurrency test
   * ``P0-1: handleSessionEnd must be scoped to its session``.
   *
   * @param sessionKey  Session whose buffered work should be flushed.
   *                    Unknown keys are tolerated as a no-op so callers
   *                    don't have to pre-check whether the session was
   *                    already evicted or never produced a capture.
   */
  async handleSessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.storeReady?.catch(() => {});
    if (!this.scheduler) return;
    await this.scheduler.flushSession(sessionKey);
  }

  // ============================
  // Accessors (for migration bridge)
  // ============================

  /** Get the LLM runner factory (for creating host-neutral LLM runners). */
  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  /** Get the shared VectorStore (may be undefined if init failed). */
  getVectorStore(): IMemoryStore | undefined {
    return this.vectorStore;
  }

  /** Get the shared EmbeddingService (may be undefined if not configured). */
  getEmbeddingService(): EmbeddingService | undefined {
    return this.embeddingService;
  }

  /** Get the pipeline scheduler (may be undefined if extraction disabled). */
  getScheduler(): MemoryPipelineManager | undefined {
    return this.scheduler;
  }

  /** Get the StorageAdapter (may be undefined in standalone/OpenClaw mode). */
  getStorage(): StorageAdapter | undefined {
    return this.storage;
  }

  /** Set the StorageAdapter (for service mode, injected by Gateway after config resolution). */
  setStorage(adapter: StorageAdapter): void {
    this.storage = adapter;
    this.logger.info(`${TAG} StorageAdapter set: type=${adapter.type}`);
  }

  /**
   * Replace the legacy MemoryPipelineManager with a StatefulPipelineManager.
   *
   * When STATE_BACKEND is configured, the Gateway injects a StatefulPipelineManager
   * that delegates all state to IStateBackend. This makes the Core process
   * stateless — capture calls go through captureAtomic and tasks are dispatched
   * to the Worker pool.
   *
   * The StatefulPipelineManager implements the same notifyConversation()/flushSession()
   * interface as MemoryPipelineManager, so performAutoCapture works unchanged.
   */
  setStatefulPipelineManager(manager: any): void {
    // Replace scheduler with the stateful version
    this.scheduler = manager;
    // Mark scheduler as "started" so ensureSchedulerStarted() becomes a no-op
    this.schedulerStartPromise = Promise.resolve();
    this.logger.info("[tdai-core] Switched to StatefulPipelineManager (distributed mode)");
  }

  /** Whether the scheduler has been started (or is currently starting). */
  isSchedulerStarted(): boolean {
    return this.schedulerStartPromise !== undefined;
  }

  /** Set the instance ID for metrics (may be resolved asynchronously). */
  setInstanceId(id: string): void {
    this.instanceId = id;
    if (this.scheduler) {
      this.scheduler.instanceId = id;
    }
  }

  // ============================
  // Internal helpers
  // ============================

  private async initStores(): Promise<void> {
    try {
      const stores = await initStores(this.cfg, this.dataDir, this.logger);
      this.vectorStore = stores.vectorStore;
      this.embeddingService = stores.embeddingService;
      this.logger.debug?.(`${TAG} Stores initialized: backend=${this.cfg.storeBackend}, embedding=${this.cfg.embedding.provider}`);
    } catch (err) {
      this.logger.warn(
        `${TAG} Store init failed; recall/dedup degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private wirePipelineRunners(): void {
    if (!this.scheduler) return;

    // Determine whether to use standalone LLM runner for extraction.
    // Priority: cfg.llm.enabled (explicit override) > hostType detection.
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";

    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    // When standalone runner is active, create LLM runners from the factory.
    // If cfg.llm is configured AND we're in OpenClaw mode, build a dedicated
    // StandaloneLLMRunnerFactory from cfg.llm to override the host runner.
    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          timeoutMs: this.cfg.llm.timeoutMs,
        },
        logger: this.logger,
      });
      this.logger.debug?.(`${TAG} Using standalone LLM override: model=${this.cfg.llm.model}, baseUrl=${this.cfg.llm.baseUrl}`);
    }

    // 用 MetricTrackingRunnerFactory 装饰器包装（非侵入式 credit 上报）
    // Kafka 未配置时 metricProducer.send() 是 no-op，零开销
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);

    const l1LlmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: false })
      : undefined;
    const l2l3LlmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    // L1 runner
    this.scheduler.setL1Runner(createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner: l1LlmRunner,
      storage: this.storage,
    }));

    // Persister
    this.scheduler.setPersister(createPersister(this.dataDir, this.logger, this.storage));

    // L2 runner
    this.scheduler.setL2Runner(async (sessionKey: string, cursor?: string) => {
      const l2Runner = createL2Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
        storage: this.storage,
      });
      return l2Runner(sessionKey, cursor);
    });

    // L3 runner
    this.scheduler.setL3Runner(async () => {
      const l3Runner = createL3Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
        storage: this.storage,
      });
      await l3Runner();
    });

    this.logger.debug?.(`${TAG} Pipeline runners wired`);
  }

  // ============================
  // Per-instance Store runners (multi-tenant)
  // ============================

  /**
   * Run L1 extraction using an externally provided Store (for multi-instance VDB).
   * Called by PipelineWorker when task.data.instanceId is present.
   *
   * Returns backlog flags (`hasMore`, `hasFullBacklog`) so the caller (the
   * service-mode worker executor) can mirror standalone-mode pipeline-manager
   * behavior: full backlog → enqueue next L1 immediately; small tail → defer
   * via L1_idle timer. See pipeline-factory.ts createL1Runner for semantics.
   */
  async runL1WithStore(
    sessionKey: string,
    store: IMemoryStore,
    embedding: EmbeddingService,
    storage?: StorageAdapter,
  ): Promise<{ storedCount: number; creditUsed: number; hasMore: boolean; hasFullBacklog: boolean }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          timeoutMs: this.cfg.llm.timeoutMs,
        },
        logger: this.logger,
      });
    }
    // 用 MetricTrackingRunnerFactory 装饰器包装（非侵入式 credit 上报）
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: false })
      : undefined;

    const runner = createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      embeddingService: embedding,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
    });
    const result = await runner({ sessionKey, msg: [], bg_msg: [] });

    // Read accumulated credit from the tracking runner (原始浮点数，与监控侧严格一致)
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    const storedCount = result?.storedCount ?? 0;
    const hasMore = result?.hasMore ?? false;
    const hasFullBacklog = result?.hasFullBacklog ?? false;
    return { storedCount, creditUsed, hasMore, hasFullBacklog };
  }

  /**
   * Run L2 scene extraction using an externally provided Store.
   */
  async runL2WithStore(sessionKey: string, store: IMemoryStore, storage?: StorageAdapter, cursor?: string): Promise<{ creditUsed: number; skipped: boolean }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          timeoutMs: this.cfg.llm.timeoutMs,
        },
        logger: this.logger,
      });
    }
    // 用 MetricTrackingRunnerFactory 装饰器包装（非侵入式 credit 上报）
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    const runner = createL2Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      logger: this.logger,
      instanceId: this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
    });
    const runnerResult = await runner(sessionKey, cursor);
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    // L2 runner returns undefined when no new L1 records, or { skipped: true } on empty extraction
    const skipped = (runnerResult === undefined && creditUsed === 0) || (runnerResult?.skipped === true);
    return { creditUsed, skipped };
  }

  /**
   * Run L3 persona generation using an externally provided Store.
   */
  async runL3WithStore(store: IMemoryStore, storage?: StorageAdapter): Promise<{ creditUsed: number }> {
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";
    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          timeoutMs: this.cfg.llm.timeoutMs,
        },
        logger: this.logger,
      });
    }
    // 用 MetricTrackingRunnerFactory 装饰器包装（非侵入式 credit 上报）
    const trackingFactory = new MetricTrackingRunnerFactory(runnerFactory, () => this.instanceId);
    const llmRunner = useStandaloneRunner
      ? trackingFactory.createRunner({ enableTools: true })
      : undefined;

    const runner = createL3Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: store,
      logger: this.logger,
      instanceId: this.instanceId,
      llmRunner,
      storage: storage ?? this.getStorage(),
    });
    await runner();
    const creditUsed: number = (llmRunner as any)?.accumulatedCredit ?? 0;
    return { creditUsed };
  }

  private ensureSchedulerStarted(): Promise<void> {
    // Fast path: already started (or starting) — every concurrent caller
    // awaits the same in-flight promise.  The promise is kept around as a
    // permanently-resolved sentinel after success so subsequent calls
    // collapse into a cheap already-resolved await.
    if (this.schedulerStartPromise) return this.schedulerStartPromise;
    if (!this.scheduler) return Promise.resolve();

    // Capture scheduler locally so TypeScript narrows inside the closure
    // even after ``this.scheduler`` is re-assigned by handleSessionEnd.
    const scheduler = this.scheduler;
    this.schedulerStartPromise = (async () => {
      try {
        const checkpoint = new CheckpointManager(this.dataDir, this.logger, this.storage);
        const cp = await checkpoint.read();
        scheduler.start(checkpoint.getAllPipelineStates(cp));
        this.logger.debug?.(`${TAG} Scheduler started`);
      } catch (err) {
        this.logger.error(`${TAG} Failed to restore checkpoint: ${err instanceof Error ? err.message : String(err)}`);
        scheduler.start({});
      }
    })();

    // If the start sequence itself rejects we clear the gate so the next
    // caller can retry; on success we keep the resolved promise so it
    // short-circuits permanently.
    this.schedulerStartPromise.catch(() => {
      this.schedulerStartPromise = undefined;
    });

    return this.schedulerStartPromise;
  }
}
