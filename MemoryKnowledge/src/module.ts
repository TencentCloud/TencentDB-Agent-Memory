/**
 * Knowledge Module Factory — assembles store / services / engines / workers / restart recovery.
 *
 * Outputs `KnowledgeModule` with all dependencies wired up for the Hono server.
 * Real code-graph worker: git clone/fetch + codegraph indexing.
 * Real wiki worker: LLM ingest via wiki engine.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import pLimit from "p-limit";

import type { Db } from "./db/client.js";
import { SqliteKnowledgeStore, type IKnowledgeStore } from "./store/index.js";
import { WikiService, type WikiWorker } from "./store/index.js";
import { CodeGraphService, type CodeGraphWorker } from "./store/index.js";
import { BuildQueue } from "./store/index.js";
import { createGitCredentialStore, type IGitCredentialStore } from "./store/index.js";
import {
  createLlmBindingStore,
  resolveLlmConfig,
  type ILlmBindingStore,
} from "./store/llm-binding-store.js";
import { createWikiSourceManager, type WikiSourceManager } from "./engines/wiki/index.js";
import { indexProject, openIndex, syncIndex, getStats, closeIndex, type CodeGraphInstance } from "./engines/code/index.js";
import {
  SourceFetcherRegistry,
  cleanupStaleGitAuthDirs,
  stripSimpleGitDebug,
} from "./source-fetcher/index.js";
import { createLogger } from "./logger.js";
import { sanitizeGitError } from "./utils/sanitize.js";
import { deriveSecretKey, SecretKeyError } from "./crypto/secret-box.js";
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
  /** LLM configuration for wiki ingest. */
  llmConfig: LlmConfig;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl?: string;
  /** Optional: externally injected wiki worker (for testing). */
  wikiWorker?: WikiWorker;
  /** Optional: externally injected code worker (for testing). */
  codeWorker?: CodeGraphWorker;
  /** Git 私有仓库接入的安全配置（来自 loadConfig().git）。 */
  git?: {
    allowedHosts?: readonly string[];
    strictHostKey?: boolean;
    knownHostsPath?: string;
  };
  /** MUST 为 KNOWLEDGE_SECRET_KEY；为空则托管凭证不可用（公开仓库路径不受影响）。 */
  secretKey?: string;
}

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  loadIfMissing?(codeGraphId: string, dir: string): Promise<CodeGraphInstance | undefined>;
}

export interface KnowledgeModule {
  wikiService: WikiService;
  cgService: CodeGraphService;
  wikiMgr: WikiSourceManager;
  store: IKnowledgeStore;
  instancePool: CodeGraphInstancePool;
  /** Per-instance LLM routing binding (proxy/byo), keyed by service_id. */
  llmBindingStore: ILlmBindingStore;
  /** 托管 git 凭证（私有仓库接入）。 */
  credentialStore: IGitCredentialStore;
  /** 凭证子系统是否可用（KNOWLEDGE_SECRET_KEY 已配置且通过强度校验）。 */
  credentialsConfigured: boolean;
  /** 复用 fetcher 的协议 / SSRF / host 白名单校验（/source-credential/test 用）。 */
  validateRepoUrl: (repoUrl: string) => void;
  /** 用指定凭证探测远端连通性（/source-credential/test 用）。 */
  probeRemote: (input: {
    repoUrl: string;
    branch?: string;
    credentialId: string;
    serviceId: string;
    teamId: string;
  }) => Promise<{ ok: boolean; error?: string; note?: string }>;
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
  const { dataDir, db, llmConfig } = config;

  // Store
  const store = new SqliteKnowledgeStore(db);

  // Managed git credentials (private repos). 主密钥不合法 → 只把「凭证能力」
  // 标记为不可用（凭证接口 503），**不影响**公开仓库路径，所以这里不抛。
  const credentialStore = createGitCredentialStore({ db, secretKey: config.secretKey ?? "" });
  const credentialsConfigured = (() => {
    try {
      deriveSecretKey(config.secretKey ?? "");
      return true;
    } catch (err) {
      if (err instanceof SecretKeyError) {
        log.warn(`[source-credential] disabled: ${err.message}`);
        return false;
      }
      throw err;
    }
  })();

  // Per-instance LLM routing binding + resolver (proxy/byo → effective LlmConfig).
  // No binding → global LLM_MODE decides: 'custom' uses global LLM_* direct,
  // 'proxy' (default) blanks creds so ingest fails loudly (no silent fallback).
  const llmBindingStore = createLlmBindingStore(db);
  const resolveLlm = (serviceId: string): LlmConfig =>
    resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), llmConfig);

  // Instance pool (code-graph) — lazy loading
  const _poolMap = new Map<string, CodeGraphInstance>();
  const instancePool: CodeGraphInstancePool = {
    get(id: string) { return _poolMap.get(id); },
    set(id: string, inst: CodeGraphInstance) { _poolMap.set(id, inst); },
    delete(id: string) { _poolMap.delete(id); },
    async loadIfMissing(id: string, dir: string) {
      if (_poolMap.has(id)) return _poolMap.get(id);
      try {
        const instance = await openIndex(dir);
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
  const fetcherRegistry = new SourceFetcherRegistry({
    allowedHosts: config.git?.allowedHosts ?? [],
    strictHostKey: config.git?.strictHostKey,
    knownHostsPath: config.git?.knownHostsPath,
    onWarn: (msg) => log.warn(`[source-fetcher] ${msg}`),
  });

  // 兜底清扫上次进程被 SIGKILL 时残留的临时私钥目录（正常路径由 finally 清理）。
  const staleDirs = cleanupStaleGitAuthDirs();
  if (staleDirs > 0) {
    log.info(`[source-fetcher] removed ${staleDirs} stale git auth temp dir(s)`);
  }

  // simple-git 的 debug 日志会打印 spawn options（含注入的 Authorization 头）→ 主动剥离。
  if (stripSimpleGitDebug()) {
    log.warn("[source-fetcher] removed 'simple-git' from DEBUG to avoid leaking git credentials into logs");
  }

  // ── Real code-graph worker: fetch/sync via SourceFetcher + index ──
  const realCodeWorker: CodeGraphWorker = async (ctx) => {
    const { dir, repoUrl, branch, codeGraphId, credentialId, serviceId, teamId, setInternalStatus } = ctx;

    // Resolve protocol-specific fetcher (validates url: protocol whitelist + host
    // whitelist + SSRF blocklist + embedded-credential rejection).
    const fetcher = fetcherRegistry.resolve(repoUrl);

    // 每次 build 现解析凭证材料（不缓存明文）；解析失败必须显式抛出，
    // 不能静默降级成匿名访问 —— 那样私有仓库会以一个含糊的认证错误失败。
    const auth = credentialId
      ? credentialStore.resolveMaterial(serviceId, teamId, repoUrl, credentialId)
      : null;
    if (credentialId && !auth) {
      throw new Error(
        `git credential ${credentialId} is unavailable for ${repoUrl} ` +
          `(deleted, or not bound to this host)`,
      );
    }
    const fetchOptions = auth ? { auth } : undefined;

    const isExistingRepo = existsSync(join(dir, ".git"));
    let didIncrementalSync = false;
    let version: string | null = null;

    if (isExistingRepo) {
      try {
        setInternalStatus("fetching");
        const res = await fetcher.sync(repoUrl, branch, dir, fetchOptions);
        version = res.version;

        setInternalStatus("indexing");
        let instance = instancePool.get(codeGraphId);
        if (!instance) {
          instance = await openIndex(dir);
        }
        await syncIndex(instance);
        instancePool.set(codeGraphId, instance);
        didIncrementalSync = true;
      } catch (err) {
        log.warn(
          `[code-graph] incremental sync failed for ${codeGraphId}, falling back to fresh clone: ${sanitizeGitError(
            err instanceof Error ? err.message : String(err),
            auth ? secretsOf(auth) : undefined,
          )}`,
        );
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    if (!didIncrementalSync) {
      mkdirSync(dir, { recursive: true });
      setInternalStatus("cloning");
      const res = await fetcher.fetch(repoUrl, branch, dir, fetchOptions);
      version = res.version;

      setInternalStatus("indexing");
      const instance = await indexProject(dir);
      instancePool.set(codeGraphId, instance);
    }

    // commit hash comes from the fetcher's FetchResult (unified after clone / sync)
    const commitHash = version ?? undefined;

    const instance = instancePool.get(codeGraphId);
    const rawStats = instance ? getStats(instance) : undefined;
    const stats = rawStats
      ? { files: rawStats.fileCount ?? rawStats.files ?? 0, nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0, edges: rawStats.edgeCount ?? rawStats.edges ?? 0 }
      : undefined;
    return { commitHash, stats };
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

  // ── AutoSync Scheduler: 定时拉取 git 仓库并更新 codegraph 索引 ──
  const autoSyncConfig = resolveAutoSyncConfig();
  const autoSyncScheduler = new AutoSyncScheduler({
    store, cgService, config: autoSyncConfig,
  });
  autoSyncScheduler.start();

  // ── 凭证校验出口（/source-credential/test 用）──
  // 复用 fetcher 自身的协议 / SSRF / host 白名单判定，避免 KS 与 fetcher 两套规则漂移。
  const validateRepoUrl = (repoUrl: string): void => {
    fetcherRegistry.resolve(repoUrl)?.validate(repoUrl);
  };

  const probeRemote: KnowledgeModule["probeRemote"] = async ({ repoUrl, branch, credentialId, serviceId, teamId }) => {
    const fetcher = fetcherRegistry.resolve(repoUrl);
    if (!fetcher.probe) return { ok: false, error: `source type ${fetcher.supportedType} does not support probing` };

    // 解析失败（已删除 / host 不匹配）必须显式失败，不能降级成匿名探测 ——
    // 否则会把「凭证不可用」报成「仓库可达」。
    const auth = credentialStore.resolveMaterial(serviceId, teamId, repoUrl, credentialId);
    if (!auth) return { ok: false, error: `git credential ${credentialId} is not usable for ${repoUrl}` };

    return fetcher.probe(repoUrl, branch, { auth });
  };

  return {
    wikiService,
    cgService,
    wikiMgr,
    store,
    instancePool,
    llmBindingStore,
    credentialStore,
    credentialsConfigured,
    validateRepoUrl,
    probeRemote,
    autoSyncScheduler,
    autoSyncConfig,
  };
}

/** 供日志脱敏使用的明文凭证列表（只为 replaceAll，不做他用）。 */
function secretsOf(auth: { kind: "https_token" | "ssh_key"; token?: string; privateKey?: string }): string[] {
  return [auth.token, auth.privateKey].filter((v): v is string => typeof v === "string" && v.length > 0);
}
