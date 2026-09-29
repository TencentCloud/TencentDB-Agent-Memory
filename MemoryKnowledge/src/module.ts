/**
 * Knowledge Module Factory — assembles store / services / engines / workers / restart recovery.
 *
 * Outputs `KnowledgeModule` with all dependencies wired up for the Hono server.
 * Real code-graph worker: git clone/fetch + codegraph indexing.
 * Real wiki worker: LLM ingest via wiki engine.
 */

import { join } from "node:path";
import pLimit from "p-limit";

import type { Db } from "./db/client.js";
import { SqliteKnowledgeStore, type IKnowledgeStore } from "./store/index.js";
import { WikiService, type WikiWorker } from "./store/index.js";
import { CodeGraphService, type CodeGraphWorker } from "./store/index.js";
import { BuildQueue } from "./store/index.js";
import {
  createLlmBindingStore,
  resolveLlmConfig,
  type ILlmBindingStore,
} from "./store/llm-binding-store.js";
import { createWikiSourceManager, type WikiSourceManager } from "./engines/wiki/index.js";
import { CodeGraphHandleCloseError, openIndex, getStats, closeIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { SourceFetcherRegistry } from "./source-fetcher/index.js";
import { createCodeGraphWorker } from "./code-graph-worker.js";
import { recoverInterruptedCodeGraphs } from "./code-graph-recovery.js";
import { acquireDataRootOwnership, acquireKnowledgeStoreOwnership, type DataRootOwnership } from "./data-root-ownership.js";
import { createLogger } from "./logger.js";
import type { LlmConfig } from "./config.js";
import { getGlobalLlmConcurrency } from "./config.js";
import { buildProgressFn } from "./callback.js";
import { AutoSyncScheduler, resolveAutoSyncConfig, type AutoSyncConfig } from "./store/auto-sync-scheduler.js";

const log = createLogger("knowledge-module");

/** 进程级全局 LLM 并发信号量（跨所有 wiki 的 extract + merge）。 */
export const globalLlmLimit = pLimit(getGlobalLlmConcurrency());

// ───────────────────────── Module Config ─────────────────────────

export interface KnowledgeModuleConfig {
  dataDir: string;
  db: Db;
  /** Path of the metadata database; required to guard external DB paths. */
  dbPath?: string;
  /** Acquired before opening the metadata DB when constructed by the server. */
  dataRootOwnership?: DataRootOwnership;
  /** LLM configuration for wiki ingest. */
  llmConfig: LlmConfig;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl?: string;
  /** Optional: externally injected wiki worker (for testing). */
  wikiWorker?: WikiWorker;
  /** Optional: externally injected code worker (for testing). */
  codeWorker?: CodeGraphWorker;
}

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  /** Hold a query lease until its handler has finished using the instance. */
  acquire?(codeGraphId: string): { instance: CodeGraphInstance; release(): void } | undefined;
  /** Stop new leases and lazy loads, then wait for existing ones to finish. */
  pause?(codeGraphId: string): Promise<void>;
  /** Acquire an exclusive pause immediately, or report an active reader. */
  tryPause?(codeGraphId: string): boolean;
  /** Retain an unclosed candidate handle so delete also drains it before rm. */
  retainUnclosed?(codeGraphId: string, instance: CodeGraphInstance, onClosed?: () => void): void;
  resume?(codeGraphId: string): void;
  loadIfMissing?(codeGraphId: string, dir: string): Promise<CodeGraphInstance | undefined>;
}

interface CodeGraphPoolIndexOps {
  openIndex: (dir: string) => Promise<CodeGraphInstance>;
  closeIndex: (instance: CodeGraphInstance) => void;
}

interface CodeGraphPoolGate {
  pauses: number;
  leases: number;
  loads: number;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  /** A discarded handle could not be closed during the current drain. */
  drainError?: unknown;
  /** Keep failed closes reachable so a later pause can retry before copying. */
  retired: Map<CodeGraphInstance, (() => void) | undefined>;
}

/** The production pool's lifecycle gate protects handles while a graph is promoted. */
export function createCodeGraphInstancePool(
  indexOps: CodeGraphPoolIndexOps = { openIndex, closeIndex },
): Required<CodeGraphInstancePool> {
  const instances = new Map<string, CodeGraphInstance>();
  const loading = new Map<string, Promise<CodeGraphInstance | undefined>>();
  const gates = new Map<string, CodeGraphPoolGate>();

  function gate(id: string) {
    let state = gates.get(id);
    if (!state) {
      state = { pauses: 0, leases: 0, loads: 0, waiters: [], retired: new Map() };
      gates.set(id, state);
    }
    return state;
  }

  function retryRetired(state: CodeGraphPoolGate): void {
    for (const [instance, onClosed] of state.retired) {
      indexOps.closeIndex(instance);
      state.retired.delete(instance);
      onClosed?.();
    }
  }

  function maybeDeleteGate(id: string, state: CodeGraphPoolGate): void {
    if (!instances.has(id) && !loading.has(id) && state.pauses === 0 && state.leases === 0 &&
        state.loads === 0 && state.waiters.length === 0 && state.retired.size === 0) {
      gates.delete(id);
    }
  }

  function notifyIdle(state: CodeGraphPoolGate) {
    if (state.leases !== 0 || state.loads !== 0) return;
    const waiters = state.waiters.splice(0);
    if (waiters.length === 0) return;
    // A close failure invalidates this drain, but must not poison every future
    // refresh. Retain the handle and retry its close on the next pause.
    let failure = state.drainError;
    state.drainError = undefined;
    if (failure === undefined) {
      try { retryRetired(state); }
      catch (err) { failure = err; }
    }
    for (const waiter of waiters) {
      if (failure !== undefined) waiter.reject(failure);
      else waiter.resolve();
    }
  }

  function discard(state: CodeGraphPoolGate, instance: CodeGraphInstance) {
    try { indexOps.closeIndex(instance); }
    catch (err) {
      state.retired.set(instance, undefined);
      state.drainError = err;
      throw err;
    }
  }

  return {
    get(id) { return instances.get(id); },
    retainUnclosed(id, instance, onClosed) {
      gate(id).retired.set(instance, onClosed);
    },
    set(id, instance) { instances.set(id, instance); },
    delete(id) {
      instances.delete(id);
      const state = gates.get(id);
      if (state) maybeDeleteGate(id, state);
    },
    acquire(id) {
      const state = gate(id);
      if (state.pauses > 0) return undefined;
      const instance = instances.get(id);
      if (!instance) return undefined;
      state.leases++;
      let released = false;
      return {
        instance,
        release() {
          if (released) return;
          released = true;
          state.leases--;
          notifyIdle(state);
          maybeDeleteGate(id, state);
        },
      };
    },
    pause(id) {
      const state = gate(id);
      // Mark paused synchronously, before the caller's first await.
      state.pauses++;
      if (state.leases === 0 && state.loads === 0) {
        const failure = state.drainError;
        state.drainError = undefined;
        if (failure !== undefined) return Promise.reject(failure);
        try { retryRetired(state); }
        catch (err) { return Promise.reject(err); }
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => { state.waiters.push({ resolve, reject }); });
    },
    tryPause(id) {
      const state = gate(id);
      if (state.pauses > 0 || state.leases > 0 || state.loads > 0) return false;
      state.pauses++;
      try {
        const failure = state.drainError;
        state.drainError = undefined;
        if (failure !== undefined) throw failure;
        retryRetired(state);
        return true;
      } catch (err) {
        state.pauses--;
        maybeDeleteGate(id, state);
        throw err;
      }
    },
    resume(id) {
      const state = gate(id);
      if (state.pauses > 0) state.pauses--;
      maybeDeleteGate(id, state);
    },
    async loadIfMissing(id, dir) {
      const state = gate(id);
      if (state.pauses > 0 || state.retired.size > 0) return undefined;
      const existing = instances.get(id);
      if (existing) return existing;
      const pending = loading.get(id);
      if (pending) return pending;

      state.loads++;
      const opening = (async () => {
        try {
          let instance: CodeGraphInstance;
          try { instance = await indexOps.openIndex(dir); }
          catch (err) {
            if (err instanceof CodeGraphHandleCloseError) {
              // A partially opened SQLite handle survived a failed close.
              // Keep it reachable so delete/refresh cannot move its files.
              state.retired.set(err.unclosedInstance, undefined);
              state.drainError = err;
            }
            log.warn(`[code-graph] lazy-load failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          }
          if (state.pauses > 0) {
            discard(state, instance);
            return undefined;
          }
          // A worker can install a freshly promoted handle while lazy open runs.
          const current = instances.get(id);
          if (current) {
            if (current !== instance) discard(state, instance);
            return current;
          }
          instances.set(id, instance);
          log.info(`[code-graph] lazy-loaded instance ${id}`);
          return instance;
        } finally {
          loading.delete(id);
          state.loads--;
          notifyIdle(state);
          maybeDeleteGate(id, state);
        }
      })();
      loading.set(id, opening);
      return opening;
    },
  };
}

/** Drain readers and lazy opens, then hold the gate through metadata/file deletion. */
export function createCodeGraphInstanceReleaser(
  instancePool: Required<CodeGraphInstancePool>,
  close: (instance: CodeGraphInstance) => void = closeIndex,
): (codeGraphId: string) => Promise<(() => void) | null> {
  return async (codeGraphId) => {
    let paused = false;
    try {
      paused = instancePool.tryPause(codeGraphId);
      if (!paused) return null;
      const inst = instancePool.get(codeGraphId);
      // Keep a handle whose close failed reachable. A later delete can retry
      // closing it; dropping the pool entry would let that retry unlink an
      // index while SQLite may still hold its WAL and database files open.
      if (inst) close(inst);
      instancePool.delete(codeGraphId);
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        instancePool.resume(codeGraphId);
      };
    } catch (err) {
      if (paused) instancePool.resume(codeGraphId);
      throw err;
    }
  };
}

export interface KnowledgeModule {
  dataRootOwnership: DataRootOwnership;
  wikiService: WikiService;
  cgService: CodeGraphService;
  wikiMgr: WikiSourceManager;
  store: IKnowledgeStore;
  instancePool: CodeGraphInstancePool;
  /** Per-instance LLM routing binding (proxy/byo), keyed by service_id. */
  llmBindingStore: ILlmBindingStore;
  /** 定时自动同步调度器（需显式 start/stop）。 */
  autoSyncScheduler: AutoSyncScheduler;
  /** 定时自动同步的解析后配置（挂载 admin 路由时透出）。 */
  autoSyncConfig: AutoSyncConfig;
}

/**
 * Create Knowledge Module (assembly entry point).
 * - Initialize Store / Service / engines
 * - Mark interrupted tasks as failed
 * - Async restore synced instances
 */
export function createKnowledgeModule(config: KnowledgeModuleConfig): KnowledgeModule {
  const ownership = config.dataRootOwnership ?? (config.dbPath
    ? acquireKnowledgeStoreOwnership(config.dataDir, config.dbPath)
    : acquireDataRootOwnership(config.dataDir));
  try { return buildKnowledgeModule(config, ownership); }
  catch (err) {
    if (!config.dataRootOwnership) ownership.release();
    throw err;
  }
}

function buildKnowledgeModule(config: KnowledgeModuleConfig, ownership: DataRootOwnership): KnowledgeModule {
  const { dataDir, db, llmConfig } = config;

  // Store
  const store = new SqliteKnowledgeStore(db);

  // Per-instance LLM routing binding + resolver (proxy/byo → effective LlmConfig).
  // No binding → global LLM_MODE decides: 'custom' uses global LLM_* direct,
  // 'proxy' (default) blanks creds so ingest fails loudly (no silent fallback).
  const llmBindingStore = createLlmBindingStore(db);
  const resolveLlm = (serviceId: string): LlmConfig =>
    resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), llmConfig);

  // Instance pool (code-graph) — lazy loading
  const instancePool = createCodeGraphInstancePool();

  // Wiki engine manager
  const wikiMgr = createWikiSourceManager(join(dataDir, "_wiki_engines"));

  // Source fetcher registry (git/local/ftp routing + security validation)
  const fetcherRegistry = new SourceFetcherRegistry();

  // Build refreshes in isolation; promote only a complete replacement index.
  const realCodeWorker = createCodeGraphWorker({
    instancePool,
    resolveFetcher: (url) => fetcherRegistry.resolve(url),
    logger: { warn: (message) => log.warn(message) },
  });

  // ── Real wiki worker: ingest via wiki engine ──
  const realWikiWorker: WikiWorker = async (ctx) => {
    const { wikiId, serviceId, teamId, dir, setInternalStatus, ingestRunId } = ctx;
    setInternalStatus("ingesting");

    // Per-instance LLM routing (proxy/byo/global fallback), keyed by service_id.
    const effectiveLlm = resolveLlm(serviceId);
    // 进度只推 Panel（Panel 内存 store + wiki/get 聚合）；KS 不落进度态
    const onProgress = config.tmcCallbackUrl
      ? buildProgressFn(config.tmcCallbackUrl, wikiId, serviceId, teamId, ingestRunId)
      : undefined;
    wikiMgr.init({ name: wikiId, path: dir });
    await wikiMgr.ingest(
      wikiId,
      {
        protocol: effectiveLlm.protocol,
        provider: effectiveLlm.provider,
        apiKey: effectiveLlm.apiKey,
        model: effectiveLlm.model,
        customEndpoint: effectiveLlm.baseUrl,
        maxContextSize: effectiveLlm.maxTokens,
        timeoutMs: effectiveLlm.timeoutMs,
        stream: effectiveLlm.stream ?? false,
      },
      { onProgress, globalLlmLimit },
    );
    setInternalStatus("rebuilding-index");

    const pages = wikiMgr.getPages(wikiId);
    return { pageCount: pages.length };
  };

  // Services (shared BuildQueue for serial wiki + code tasks)
  const callbackConfig = config.tmcCallbackUrl
    ? { tmcCallbackUrl: config.tmcCallbackUrl, resolveLlm }
    : undefined;

  const sharedQueue = new BuildQueue();
  const wikiService = new WikiService({
    store,
    dataRoot: dataDir,
    worker: config.wikiWorker ?? realWikiWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
  });
  const cgService = new CodeGraphService({
    store,
    dataRoot: dataDir,
    worker: config.codeWorker ?? realCodeWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
    releaseInstance: createCodeGraphInstanceReleaser(instancePool),
  });

  // A refresh still has a last-good index; an initial build does not.
  const restored = recoverInterruptedCodeGraphs(store, dataDir, { warn: (message) => log.warn(message) });
  if (restored > 0) log.info(`restored ${restored} interrupted code-graph refresh(es)`);

  // Restart recovery: mark remaining interrupted tasks as failed
  const interrupted = store.markInterruptedAsFailed();
  if (interrupted > 0) {
    log.info(`marked ${interrupted} interrupted tasks as failed`);
  }

  // Background restore of synced instances (non-blocking)
  void (async () => {
    // Code-graph: lazy loading, just fix stats on startup
    try {
      const allSynced = store.listSyncedCodeGraphs();
      for (const row of allSynced) {
        const dir = join(dataDir, row.service_id, row.team_id, row.code_graph_id);
        try {
          const instance = await instancePool.loadIfMissing(row.code_graph_id, dir);
          if (!instance) continue;
          const rawStats = getStats(instance);
          if (rawStats) {
            const statsJson = JSON.stringify({
              files: rawStats.fileCount ?? rawStats.files ?? 0,
              nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0,
              edges: rawStats.edgeCount ?? rawStats.edges ?? 0,
            });
            store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { stats_json: statsJson });
          }
          log.info(`[code-graph] restored ${row.code_graph_id}`);
        } catch (err) {
          log.warn(`[code-graph] failed to restore ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log.info(`[code-graph] ${allSynced.length} synced instances restored`);
    } catch (err) {
      log.warn(`[code-graph] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Wiki: register to engine manager
    try {
      const allSyncedWikis = store.listSyncedWikis();
      for (const row of allSyncedWikis) {
        const dir = join(dataDir, row.service_id, row.team_id, row.wiki_id);
        try {
          wikiMgr.init({ name: row.wiki_id, path: dir });
          const pages = wikiMgr.getPages(row.wiki_id);
          if (pages.length > 0) {
            store.updateWikiStatus(row.service_id, row.wiki_id, { page_count: pages.length });
          }
          log.info(`[wiki] restored index ${row.wiki_id} (${pages.length} pages)`);
        } catch (err) {
          log.warn(`[wiki] failed to restore ${row.wiki_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`[wiki] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // ── AutoSync Scheduler: 定时拉取 git 仓库并更新 codegraph 索引 ──
  const autoSyncConfig = resolveAutoSyncConfig();
  const autoSyncScheduler = new AutoSyncScheduler({
    store, cgService, config: autoSyncConfig,
  });
  autoSyncScheduler.start();

  return { dataRootOwnership: ownership, wikiService, cgService, wikiMgr, store, instancePool, llmBindingStore, autoSyncScheduler, autoSyncConfig };
}
