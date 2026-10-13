/**
 * Knowledge Module Factory — assembles store / services / engines / workers / restart recovery.
 *
 * Outputs `KnowledgeModule` with all dependencies wired up for the Hono server.
 * Real code-graph worker: git clone/fetch + codegraph indexing.
 * Real wiki worker: LLM ingest via wiki engine.
 */

import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
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
import { indexProject, openIndex, syncIndex, getStats, closeIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { SourceFetcherRegistry } from "./source-fetcher/index.js";
import { createLogger } from "./logger.js";
import type { LlmConfig } from "./config.js";
import { getGlobalLlmConcurrency } from "./config.js";
import { buildProgressFn } from "./callback.js";
import {
  AutoSyncScheduler,
  resolveAutoSyncConfig,
  type AutoSyncConfig,
  type WikiImporter,
} from "./store/auto-sync-scheduler.js";
import { createCredentialStore } from "./source-auth/credential-store.js";
import type { ICredentialStore } from "./source-auth/types.js";
import { buildCloneUrl, stripCredentials } from "./code-source/clone-url.js";
import type { GitCredential } from "./source-fetcher/types.js";
import { CodeSourceRegistry } from "./code-source/registry.js";
import { WikiSourceRegistry } from "./wiki-source/registry.js";
import { createWikiImporter } from "./wiki-source/wiki-importer.js";

const log = createLogger("knowledge-module");

/** 进程级全局 LLM 并发信号量（跨所有 wiki 的 extract + merge）。 */
export const globalLlmLimit = pLimit(getGlobalLlmConcurrency());

// ───────────────────────── Module Config ─────────────────────────

export interface KnowledgeModuleConfig {
  dataDir: string;
  db: Db;
  /** LLM configuration for wiki ingest. */
  llmConfig: LlmConfig;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl?: string;
  /** Optional: externally injected wiki worker (for testing). */
  wikiWorker?: WikiWorker;
  /** Optional: externally injected code worker (for testing). */
  codeWorker?: CodeGraphWorker;
  /** Optional: externally injected credential store (for testing). */
  credentialStore?: ICredentialStore;
  /** Optional: wiki 拉取服务（外部 wiki 定时同步用）；未注入 → wiki 同步目标跳过。 */
  wikiImporter?: WikiImporter;
}

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  loadIfMissing?(codeGraphId: string, dir: string): Promise<CodeGraphInstance | undefined>;
  acquireGuard?(codeGraphId: string): boolean;
  releaseGuard?(codeGraphId: string): void;
}

export interface KnowledgeModule {
  wikiService: WikiService;
  cgService: CodeGraphService;
  wikiMgr: WikiSourceManager;
  /** wiki 外部来源注册中心（iWiki 等）。 */
  wikiSourceRegistry: WikiSourceRegistry;
  store: IKnowledgeStore;
  instancePool: CodeGraphInstancePool;
  /** Per-instance LLM routing binding (proxy/byo), keyed by service_id. */
  llmBindingStore: ILlmBindingStore;
  /** 定时自动同步调度器（需显式 start/stop）。 */
  autoSyncScheduler: AutoSyncScheduler;
  /** 定时自动同步的解析后配置（挂载 admin 路由时透出）。 */
  autoSyncConfig: AutoSyncConfig;
  /** Source credentials are base64-encoded, not encrypted; protect the database and backups. */
  credentialStore: ICredentialStore;
  /** 代码来源 provider 注册中心（前端下拉 + provider 查询）。 */
  codeSourceRegistry: CodeSourceRegistry;
}

/**
 * Create Knowledge Module (assembly entry point).
 * - Initialize Store / Service / engines
 * - Mark interrupted tasks as failed
 * - Async restore synced instances
 */
export function createKnowledgeModule(config: KnowledgeModuleConfig): KnowledgeModule {
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
  const _poolMap = new Map<string, CodeGraphInstance>();
  const _mutating = new Set<string>();
  const _generation = new Map<string, number>();

  const instancePool = {
    get(id: string) { return _mutating.has(id) ? undefined : _poolMap.get(id); },
    set(id: string, inst: CodeGraphInstance) { _poolMap.set(id, inst); },
    delete(id: string) { _poolMap.delete(id); },
    acquireGuard(id: string) {
      if (_mutating.has(id)) return false;
      const oldInstance = _poolMap.get(id);
      if (oldInstance) {
        closeIndex(oldInstance);
        _poolMap.delete(id);
      }
      _mutating.add(id);
      _generation.set(id, (_generation.get(id) || 0) + 1);
      return true;
    },
    releaseGuard(id: string) { _mutating.delete(id); },
    async loadIfMissing(id: string, dir: string) {
      if (_mutating.has(id)) return undefined;
      if (_poolMap.has(id)) return _poolMap.get(id);
      const startGen = _generation.get(id) || 0;
      try {
        const instance = await openIndex(dir);
        if (_mutating.has(id) || (_generation.get(id) || 0) !== startGen) {
          closeIndex(instance);
          return undefined;
        }
        _poolMap.set(id, instance);
        log.info(`[code-graph] lazy-loaded instance ${id}`);
        return instance;
      } catch (err) {
        log.warn(`[code-graph] lazy-load failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
  };

  // Wiki engine manager
  const wikiMgr = createWikiSourceManager(join(dataDir, "_wiki_engines"));

  // Source fetcher registry (git/local/ftp routing + security validation)
  const fetcherRegistry = new SourceFetcherRegistry();

  // ── 外部来源凭据存储（base64；无密钥；见 §4.1.3） ──
  const credentialStore = config.credentialStore ?? createCredentialStore({ db });

  // ── 代码来源 provider 注册中心（内置 + 部署启用列表） ──
  const codeSourceRegistry = new CodeSourceRegistry();

  // ── wiki 来源 provider 注册中心（内置 + 部署启用列表） ──
  const wikiSourceRegistry = new WikiSourceRegistry();

  // ── Real code-graph worker: fetch/sync via SourceFetcher + index ──
  const realCodeWorker: CodeGraphWorker = async (ctx) => {
    const { dir, repoUrl, branch, codeGraphId, serviceId, setInternalStatus } = ctx;

    // Reject caller URL credentials before a provider could strip or replace them.
    let originalUrl: URL;
    try { originalUrl = new URL(repoUrl); }
    catch { throw new Error("Invalid repository URL"); }
    if (originalUrl.username || originalUrl.password) {
      throw new Error("Repository URL credentials are not allowed; use resource credentials");
    }

    const credentialRef = { type: "code-graph" as const, serviceId, resourceId: codeGraphId };
    let sourceUrl = repoUrl;
    let gitCredential: GitCredential | undefined;
    const credentialStatus = credentialStore.status(credentialRef);
    if (credentialStatus) {
      const credential = credentialStore.get(credentialRef);
      const provider = codeSourceRegistry.get(credentialStatus.provider_id);
      if (!credential || !provider) throw new Error("Resource Git credentials or provider are unavailable");
      // Provider transformations stay in memory. Only a clean URL goes to Git.
      const authenticated = new URL(buildCloneUrl(provider, repoUrl, credential));
      gitCredential = { username: decodeURIComponent(authenticated.username), password: decodeURIComponent(authenticated.password) };
      sourceUrl = stripCredentials(authenticated.toString());
    }

    if (!instancePool.acquireGuard(codeGraphId)) {
      throw new Error("Concurrent mutation detected");
    }

    try {
      // Resolve protocol-specific fetcher (validates url: https-only + SSRF blocklist).
      const fetcher = fetcherRegistry.resolve(sourceUrl);

      const isExistingRepo = existsSync(join(dir, ".git"));
      let didIncrementalSync = false;
      let version: string | null = null;

      if (isExistingRepo) {
        setInternalStatus("fetching");

        try {
          const res = await fetcher.sync(sourceUrl, branch, dir, gitCredential);
          version = res.version;

          setInternalStatus("indexing");
          const instance = await openIndex(dir);
          try {
            await syncIndex(instance);
            instancePool.set(codeGraphId, instance);
            didIncrementalSync = true;
          } catch (e) {
            closeIndex(instance);
            throw e;
          }
        } catch (err) {
          log.warn(
            `[code-graph] incremental sync failed for ${codeGraphId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      }

      if (!didIncrementalSync) {
        if (fetcher.supportedType === "git") {
          mkdirSync(dirname(dir), { recursive: true });
        } else {
          mkdirSync(dir, { recursive: true });
        }
        setInternalStatus("cloning");
        const res = await fetcher.fetch(sourceUrl, branch, dir, gitCredential);
        version = res.version;

        setInternalStatus("indexing");
        const instance = await indexProject(dir);
        instancePool.set(codeGraphId, instance);
      }

      // commit hash comes from the fetcher's FetchResult (unified after clone / sync)
      const commitHash = version ?? undefined;

      const instance = _poolMap.get(codeGraphId);
      const rawStats = instance ? getStats(instance) : undefined;
      const stats = rawStats
        ? { files: rawStats.fileCount ?? rawStats.files ?? 0, nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0, edges: rawStats.edgeCount ?? rawStats.edges ?? 0 }
        : undefined;
      return { commitHash, stats };
    } finally {
      instancePool.releaseGuard(codeGraphId);
    }
  };

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
    // 释放 code-graph 内存资源（008 delete 清理）：从 pool 移除并关闭索引句柄。幂等。
    releaseInstance: (codeGraphId: string) => {
      const inst = instancePool.get(codeGraphId);
      if (inst) closeIndex(inst);
      instancePool.delete(codeGraphId);
    },
    credentialStore,
    codeSourceRegistry,
  });

  // Restart recovery: mark interrupted tasks as failed
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
          const instance = await openIndex(dir);
          instancePool.set(row.code_graph_id, instance);
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

  // ── AutoSync Scheduler: 定时拉取 git 仓库并更新 codegraph / 外部 wiki ──
  const autoSyncConfig = resolveAutoSyncConfig();
  const autoSyncScheduler = new AutoSyncScheduler({
    store,
    cgService,
    config: autoSyncConfig,
    // wiki 同步**跟随全局开关**，无 per-wiki 开关：
    // 只要 KNOWLEDGE_AUTO_SYNC_ENABLED 开启，所有「存过凭据的 wiki」
    // （= 外部来源，§4.2 用凭据行存在性判定）都会参与定时同步。
    // 未注入时（如测试）wiki 目标跳过，code-graph 行为不变。
    wikiImporter:
      config.wikiImporter ??
      createWikiImporter({
        registry: wikiSourceRegistry,
        wikiService,
        store,
      }),
    credentialStore,
  });
  autoSyncScheduler.start();

  return {
    wikiService, cgService, wikiMgr, store, instancePool,
    llmBindingStore, autoSyncScheduler, autoSyncConfig, credentialStore,
    codeSourceRegistry, wikiSourceRegistry,
  };
}
