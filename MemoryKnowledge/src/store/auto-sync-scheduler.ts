/**
 * AutoSyncScheduler — 定时拉取 git 仓库并更新 codegraph 索引。
 *
 * 模型：FIFO 队列 + 定长 worker pool。
 *   - Scanner：每 scanIntervalMs 扫描一次所有 ready 状态的仓库；
 *     用 Set 去重（已入队或 worker 处理中的跳过）后 push 到内存 queue。
 *   - Workers：常驻 maxConcurrentSyncs 个协程，FIFO 从 queue 取任务调
 *     CodeGraphService.sync()；队列空时轮询等待，stop 后自然退出。
 *
 * 单仓库同步频率 = max(单次 sync 耗时, scanIntervalMs)。无额外冷却字段——
 * 想控制频率直接调 SCAN_INTERVAL_MIN。
 *
 * 设计目标（源自需求）：
 *   1. 定时感知 git 仓库更新，自动拉取最新代码并重建 codegraph 索引
 *   2. 使用任务队列，避免突发性大量拉取打爆服务（并发受 worker 数硬限）
 *   3. 队列内 + 处理中的仓库不重复入队（Set 去重，队列大小上界 = 仓库数）
 *   4. 单个仓库同步失败不影响其他仓库（worker 吞异常继续消费）
 *   5. 复用 CodeGraphService.sync() 已有的 busy/not_found 拒绝语义
 *
 * 环境变量配置：
 *   - KNOWLEDGE_AUTO_SYNC_ENABLED: 启用开关 (default: false)
 *   - KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN: 扫描周期（分钟）(default: 10)
 *   - KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT: 全局最大并发同步数 (default: 3)
 */

import { createLogger } from "../logger.js";
import type { CodeGraphService, SyncResult } from "./code-graph-service.js";
import type { IKnowledgeStore } from "./types.js";
import { toCodeGraphTarget, toWikiTarget, type SyncTarget } from "./auto-sync-target.js";
import type { ICredentialStore, SourceCredential } from "../source-auth/types.js";

const log = createLogger("auto-sync-scheduler");

// ───────────────────────── Configuration ─────────────────────────

export interface AutoSyncConfig {
  /** 是否启用自动同步。默认 false（需显式开启）。 */
  enabled: boolean;
  /** 主循环扫描周期（毫秒）。默认 10 分钟。 */
  scanIntervalMs: number;
  /** 全局最大并发同步数（= worker 数量）。默认 3。 */
  maxConcurrentSyncs: number;
}

const MIN_MS = 60 * 1000;
/** worker 空转时的轮询间隔（ms）。测试 fake timer 下也能被 advance。 */
const WORKER_IDLE_POLL_MS = 100;

/**
 * 从环境变量解析配置，支持 fallback 默认值。
 * 所有数值字段做 clamp 防止不合理配置。
 */
export function resolveAutoSyncConfig(env: Record<string, string | undefined> = process.env): AutoSyncConfig {
  const enabled = parseBoolean(env.KNOWLEDGE_AUTO_SYNC_ENABLED, false);
  const scanIntervalMin = clamp(parseFloat(env.KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN ?? "") || 10, 1, 60);
  const maxConcurrent = clamp(parseInt(env.KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT ?? "") || 3, 1, 20);

  return {
    enabled,
    scanIntervalMs: scanIntervalMin * MIN_MS,
    maxConcurrentSyncs: maxConcurrent,
  };
}

// ───────────────────────── Scheduler ─────────────────────────

/**
 * wiki 拉取服务（外部 wiki 定时同步用）。
 * 返回本次写入的页面数。实现在 wiki-source/，接入后由 module.ts 注入。
 */
export interface WikiImporter {
  run(
    serviceId: string,
    teamId: string,
    wikiId: string,
    cred: SourceCredential,
  ): Promise<number>;
}

export interface AutoSyncSchedulerDeps {
  store: IKnowledgeStore;
  cgService: CodeGraphService;
  config: AutoSyncConfig;
  /** 外部 wiki 拉取服务；未注入时 wiki 同步目标一律跳过（不影响 code-graph）。 */
  wikiImporter?: WikiImporter;
  /** 外部来源凭据存储；未注入时 wiki 同步目标一律跳过。 */
  credentialStore?: ICredentialStore;
}

export interface AutoSyncStatus {
  /** 调度器是否已 start（未 stop）。 */
  running: boolean;
  /** 当前 worker 正在执行的 sync 任务数。 */
  activeSyncs: number;
  /** 队列中等待处理的仓库数。 */
  queueLength: number;
  /** 上一轮 scan 是否仍在进行中（避免重入）。 */
  scanning: boolean;
}

export class AutoSyncScheduler {
  private readonly store: IKnowledgeStore;
  private readonly cgService: CodeGraphService;
  private readonly config: AutoSyncConfig;
  private readonly wikiImporter?: WikiImporter;
  private readonly credentialStore?: ICredentialStore;

  /** 启动延迟 + 周期 scan 的 timer。 */
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** worker 空转 sleep 的 timer 集合（stop 时统一清理）。 */
  private readonly workerSleepTimers = new Set<ReturnType<typeof setTimeout>>();

  /** FIFO 待处理队列 + 去重 Set（存 target.key，跨类型不冲突）。 */
  private readonly queue: SyncTarget[] = [];
  private readonly inFlight = new Set<string>();

  /** 当前正在执行 sync 的 worker 数。 */
  private activeSyncs = 0;
  /** worker 数（常驻）。 */
  private workerCount = 0;
  /** 停止标记。stop 后 workers 循环退出。 */
  private stopped = true;
  /** 上一轮 scan 是否仍在进行。 */
  private scanning = false;

  constructor(deps: AutoSyncSchedulerDeps) {
    this.store = deps.store;
    this.cgService = deps.cgService;
    this.config = deps.config;
    this.wikiImporter = deps.wikiImporter;
    this.credentialStore = deps.credentialStore;
  }

  /**
   * 启动调度：
   *   - 延迟 30s 首扫（让 restore 先完成，避免抢磁盘）
   *   - 周期 scanIntervalMs 扫描
   *   - 启动 maxConcurrentSyncs 个常驻 worker
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("[auto-sync] disabled by config, skipping start");
      return;
    }
    if (!this.stopped) {
      log.warn("[auto-sync] already started");
      return;
    }
    this.stopped = false;
    log.info("[auto-sync] starting scheduler", {
      scanIntervalMs: this.config.scanIntervalMs,
      maxConcurrentSyncs: this.config.maxConcurrentSyncs,
    });

    // 启动常驻 worker pool
    for (let i = 0; i < this.config.maxConcurrentSyncs; i++) {
      this.workerCount++;
      void this.runWorker(i).finally(() => { this.workerCount--; });
    }

    // 延迟首扫 30s
    const startupDelay = 30_000;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.stopped) return;
      void this.scan();
      this.scanTimer = setInterval(() => {
        if (this.stopped) return;
        void this.scan();
      }, this.config.scanIntervalMs);
    }, startupDelay);
    log.info(`[auto-sync] first scan in ${startupDelay / 1000}s`);
  }

  /** 停止调度器：取消 timer、通知 worker 退出（已在跑的 sync 自然完成）。 */
  stop(): void {
    this.stopped = true;
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const t of this.workerSleepTimers) clearTimeout(t);
    this.workerSleepTimers.clear();
    log.info("[auto-sync] stopped");
  }

  /** 状态快照（管理 API 使用）。 */
  getStatus(): AutoSyncStatus {
    return {
      running: !this.stopped,
      activeSyncs: this.activeSyncs,
      queueLength: this.queue.length,
      scanning: this.scanning,
    };
  }

  /** 手动触发一轮扫描（管理 API 使用）。不影响定时周期。disabled 时 no-op。 */
  triggerScan(): void {
    if (!this.config.enabled) {
      log.warn("[auto-sync] cannot trigger: scheduler is disabled");
      return;
    }
    log.info("[auto-sync] manual scan triggered");
    void this.scan();
  }

  // ───────────────────────── Core scan loop ─────────────────────────

  /**
   * 一轮扫描：
   *   1. 列出所有 ready 状态的 code-graph
   *   2. 用 inFlight Set 去重（队列内 / 处理中的不再入队）
   *   3. FIFO push 到 queue，worker 会自动消费
   */
  private async scan(): Promise<void> {
    if (this.scanning) {
      log.debug("[auto-sync] previous scan still running, skip this round");
      return;
    }
    this.scanning = true;
    try {
      log.info("[auto-sync] scan started");

      const candidates = this.listSyncCandidates();
      if (candidates.length === 0) {
        log.info("[auto-sync] no ready repos");
        return;
      }

      let enqueued = 0;
      for (const target of candidates) {
        if (this.stopped) break;
        if (this.inFlight.has(target.key)) continue; // 已在队列或处理中
        this.inFlight.add(target.key);
        this.queue.push(target);
        enqueued++;
      }
      log.info(`[auto-sync] enqueued ${enqueued} repo(s) (queue=${this.queue.length}, active=${this.activeSyncs})`);
    } catch (err) {
      log.error(`[auto-sync] scan error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 列出需要同步的 code-graph：只挑 status = ready 的。
   * 已在队列或 worker 处理中的仓库由 scan() 里的 inFlight Set 去重，不重复入队；
   * 单仓库的同步节奏天然由 max(sync 耗时, scanIntervalMs) 决定，无需额外冷却。
   */
  private listSyncCandidates(): SyncTarget[] {
    const candidates: SyncTarget[] = [];

    // ① code-graph：status = ready（原逻辑，仅包一层 target）
    for (const ref of this.store.listSyncedCodeGraphs()) {
      try {
        const row = this.store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
        if (!row) continue;
        if (row.status !== "ready") continue;
        candidates.push(toCodeGraphTarget(row));
      } catch (err) {
        log.warn(`[auto-sync] failed to check ${ref.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ② wiki：**有凭据行的 wiki**（等价于「外部导入」，§4.2）
    if (this.credentialStore) {
      for (const ref of this.credentialStore.listAllByType("wiki")) {
        try {
          const row = this.store.getWikiById(ref.serviceId, ref.resourceId);
          if (!row) continue;                              // 资源已删
          candidates.push(toWikiTarget(row));
        } catch (err) {
          log.warn(`[auto-sync] failed to check wiki ${ref.resourceId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return candidates;
  }

  // ───────────────────────── Worker pool ─────────────────────────

  /**
   * 一个常驻 worker：循环 shift 队列执行 sync；空则短睡后重试。
   * stop() 后 loop 自然退出。异常一律吞掉（记录日志），保证 worker 不死。
   */
  private async runWorker(workerIdx: number): Promise<void> {
    log.debug(`[auto-sync] worker#${workerIdx} started`);
    while (!this.stopped) {
      const target = this.queue.shift();
      if (!target) {
        await this.sleep(WORKER_IDLE_POLL_MS);
        continue;
      }

      this.activeSyncs++;
      try {
        await this.syncOne(target);
      } catch (err) {
        // syncOne 内已捕获，这里是兜底
        log.error(`[auto-sync] worker#${workerIdx} unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.activeSyncs--;
        this.inFlight.delete(target.key);
      }
    }
    log.debug(`[auto-sync] worker#${workerIdx} exiting`);
  }

  /** 按目标类型分派。 */
  private async syncOne(target: SyncTarget): Promise<void> {
    return target.kind === "code-graph" ? this.syncCodeGraph(target) : this.syncWiki(target);
  }

  /** 对单个 code-graph 执行 sync（复用 CodeGraphService.sync 的判别联合）。 */
  private async syncCodeGraph(t: Extract<SyncTarget, { kind: "code-graph" }>): Promise<void> {
    const row = t.row;
    const startMs = Date.now();
    log.info(`[auto-sync] sync ${row.code_graph_id} (${row.repo_url}@${row.branch})`);
    try {
      // CodeGraphService.sync 目前是同步返回 SyncResult；await 兼容未来改 async 或测试 mock。
      const result: SyncResult = await Promise.resolve(
        this.cgService.sync(row.service_id, row.team_id, row.code_graph_id, undefined),
      );
      const durationMs = Date.now() - startMs;
      switch (result.kind) {
        case "ok":
          log.info(`[auto-sync] sync enqueued for ${row.code_graph_id} (took ${durationMs}ms)`);
          // sync() only enqueues a per-asset build. Hold this worker slot until
          // that build completes; enqueue acceptance is not sync completion.
          await this.cgService.onIdle(row.code_graph_id);
          break;
        case "busy":
          log.debug(`[auto-sync] skip ${row.code_graph_id}: already ${result.status} (step: ${result.step})`);
          break;
        case "not_found":
          log.warn(`[auto-sync] skip ${row.code_graph_id}: not found (may have been deleted)`);
          break;
      }
    } catch (err) {
      log.error(`[auto-sync] sync failed for ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 同步一个外部 wiki：取 owner 令牌 → 调 WikiImportService 拉取 + ingest。
   *
   * 关键约束（设计 §5.4）：**失败不写 knowledge_wiki.sync_error** —— 那字段是
   * ingest 抽取错误，混用会导致"wiki 到底好不好"无法判断。同步失败只记日志。
   *
   * 当前 wiki provider（iWiki）尚未接入：无拉取服务时直接跳过，
   * 保证 code-graph 自动同步行为与改造前完全一致。
   */
  private async syncWiki(t: Extract<SyncTarget, { kind: "wiki" }>): Promise<void> {
    const wiki = t.row;
    if (!this.wikiImporter) {
      log.debug(`[auto-sync] wiki sync skipped (no importer wired): ${wiki.wiki_id}`);
      return;
    }
    const cred = this.credentialStore?.get({
      type: "wiki",
      serviceId: t.serviceId,
      resourceId: wiki.wiki_id,
    });
    if (!cred) {
      // 无凭据行 = 手工上传的 wiki，不应进入候选（防御式检查）；或用户删了凭据。
      log.warn(`[auto-sync] wiki ${wiki.wiki_id} credential missing, skip sync`);
      return;
    }
    try {
      const n = await this.wikiImporter.run(t.serviceId, t.teamId, wiki.wiki_id, cred);
      log.info(`[auto-sync] wiki ${wiki.wiki_id} synced (${n} pages)`);
    } catch (err) {
      // 只记日志，不写 sync_error（见上）。
      log.error(
        `[auto-sync] wiki sync failed for ${wiki.wiki_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** setTimeout 版 sleep，stop 时统一清理避免测试环境 timer 泄漏。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.workerSleepTimers.delete(t);
        resolve();
      }, ms);
      this.workerSleepTimers.add(t);
    });
  }
}

// ───────────────────────── Helpers ─────────────────────────

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val == null || val.trim() === "") return fallback;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
