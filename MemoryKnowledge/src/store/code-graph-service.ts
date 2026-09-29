/**
 * CodeGraphService — code-graph 资产的异步编排。
 *
 * 把 IKnowledgeStore（元数据/状态）+ BuildQueue（后台串行）+ 可注入的
 * worker（实际 git clone + codegraph 建图）粘合，实现：
 *   - create 入队后立即返回；sync 完成准入和入队后返回，管控轮询 status；
 *   - 状态机 pending → processing(cloning/indexing) → ready / failed(+sync_error)；
 *   - memory + team 隔离、幂等（同 memory+team+repo+branch 返回已存在）、硬删 + 四类资源清理。
 *
 * delete 语义（008 / 007 §5.5）：任何状态（含 pending/processing）均可删。
 * 删除遇到运行中的 build/查询立即返回 busy；空闲时硬删元数据，异步清理目录。
 * 远端元数据上报本阶段不做。
 *
 * worker 注入便于单测（无需真实 git/codegraph）；生产实现见 router 装配处。
 * 物理目录：{dataRoot}/{service_id}/{team_id}/{code_graph_id}/（001 多租户）。
 */

import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";

import type {
  AuditAction,
  CodeGraphRow,
  IKnowledgeStore,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";

export interface CodeGraphBuildContext {
  codeGraphId: string;
  serviceId: string;
  teamId: string;
  repoUrl: string;
  branch: string;
  /** 该资产的本地工作目录（checkout + 索引落此）。 */
  dir: string;
  /** The admitted row was ready, so a committed last-good index should exist. */
  hadReadyIndex: boolean;
  /** Failed-state canonical bytes are preserved during a fresh retry, but never served. */
  preserveUntrustedCanonical: boolean;
  /** worker 可调用以更新细粒度内部状态（cloning → indexing）。 */
  setInternalStatus: (s: string) => void;
}

export interface CodeGraphBuildResult {
  commitHash?: string;
  stats?: { files: number; nodes: number; edges: number };
  /** Remove the previous snapshot only after the new metadata is committed. */
  finalize?: () => void | Promise<void>;
  /** Restore the previous snapshot if metadata could not be committed. */
  rollback?: () => Promise<void>;
}

export type CodeGraphWorker = (ctx: CodeGraphBuildContext) => Promise<CodeGraphBuildResult>;

/** A refresh failed, but the previous checkout and index are still usable. */
export class PreservedCodeGraphError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PreservedCodeGraphError";
  }
}

/**
 * sync 结果（判别联合）：
 *   - ok       已入队重建；
 *   - not_found memory/team/id 不匹配；
 *   - busy     正在 pending/processing（并发拒绝，对应 HTTP 409），step 为内部阶段（可 null）。
 *   - conflict CAS 未获准但竞争方已完成或修改状态（对应 HTTP 409）。
 */
export type SyncResult =
  | { kind: "ok"; row: CodeGraphRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null }
  | { kind: "conflict" };

export interface CodeGraphServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodeGraphServiceOptions {
  store: IKnowledgeStore;
  /** knowledge 数据根目录；资产目录 = {dataRoot}/{service_id}/{team_id}/{code_graph_id}/。 */
  dataRoot: string;
  worker: CodeGraphWorker;
  queue?: BuildQueue;
  logger?: CodeGraphServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: { tmcCallbackUrl: string };
  /**
   * Try to exclude readers and lazy loads without waiting. Null means busy.
   * The returned function releases the gate after file removal. The
   * implementation must release its gate if it throws.
   */
  releaseInstance?: (codeGraphId: string) => Promise<(() => void) | null>;
}

export interface CreateCodeGraphParams {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
}

export class CodeGraphService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: CodeGraphWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: CodeGraphServiceLogger;
  private readonly callbackConfig?: { tmcCallbackUrl: string };
  private readonly releaseInstance?: (codeGraphId: string) => Promise<(() => void) | null>;
  /** An accepted delete rejects new sync until its metadata commit returns. */
  private readonly deleting = new Set<string>();
  /** A failed file removal may be retried only for an asset this service deleted. */
  private readonly pendingCleanup = new Map<string, string>();
  private readonly cleanupJobs = new Map<string, Promise<void>>();
  constructor(opts: CodeGraphServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
    this.releaseInstance = opts.releaseInstance;
  }

  dirFor(serviceId: string, teamId: string, codeGraphId: string): string {
    return join(this.dataRoot, serviceId, teamId, codeGraphId);
  }

  /**
   * 幂等创建并异步建图。
   * - 已存在（同 memory+team+repo+branch）→ 直接返回已有行，不重复建图。
   * - 新建 → 入库 pending + 后台建图。
   */
  create(params: CreateCodeGraphParams): { row: CodeGraphRow; existed: boolean } {
    const { row, existed } = this.store.createCodeGraph(params);
    if (!existed) {
      this.audit(row, "create", `clone ${row.repo_url}@${row.branch}`, params.user_id);
      this.enqueueBuild(row);
    }
    return { row, existed };
  }

  /** Persist service_url for a code-graph. Returns updated row or null. */
  updateServiceUrl(serviceId: string, codeGraphId: string, serviceUrl: string): CodeGraphRow | null {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, { service_url: serviceUrl });
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  /** Update code-graph metadata (repo_name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): CodeGraphRow | null {
    return this.store.updateCodeGraphMeta(serviceId, codeGraphId, patch);
  }

  /** 重新拉取 + 重建（管控显式触发）。memory/team 不匹配返回 not_found；pending/processing 返回 busy。 */
  async sync(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): Promise<SyncResult> {
    if (this.deleting.has(codeGraphId)) return { kind: "conflict" };
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // 并发拒绝：正在排队/执行中直接拒绝，不覆盖状态、不重复入队、不写 audit。
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const hadReadyIndex = row.status === "ready" && row.has_last_good;
    const assetDir = this.dirFor(serviceId, teamId, codeGraphId);
    if (row.status === "failed" && (existsSync(`${assetDir}.previous`) || existsSync(`${assetDir}.suspect`))) {
      // A failed promotion still has a backup whose role cannot be inferred
      // from metadata alone. Startup recovery arbitrates it before retry.
      return { kind: "conflict" };
    }
    const preserveUntrustedCanonical = row.status === "failed" && existsSync(assetDir);
    const observedVersion = row.version;
    // The admission must be atomic across separate services sharing this store.
    // A losing caller never touches .previous, audits, or enqueues a worker.
    if (!this.store.tryAdmitCodeGraphSync(serviceId, teamId, codeGraphId, observedVersion)) {
      const current = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
      if (!current) return { kind: "not_found" };
      if (current.status === "pending" || current.status === "processing") {
        return { kind: "busy", status: current.status, step: current.internal_status };
      }
      return { kind: "conflict" };
    }

    // Keep admission and enqueue in the same event-loop turn. The worker
    // removes a retired .previous before copying; an await here would let a
    // delete queue ahead of this admitted but not-yet-enqueued build.
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!fresh) return { kind: "not_found" };
    if (fresh.status !== "pending" || fresh.version !== observedVersion + 1) return { kind: "conflict" };
    this.audit(fresh, "ingest", "manual sync", requesterUserId);
    this.enqueueBuild(fresh, hadReadyIndex, preserveUntrustedCanonical);
    return { kind: "ok", row: fresh };
  }

  get(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraph(serviceId, teamId, codeGraphId);
  }

  /** 按全局唯一 code_graph_id 查询（仍按 service_id 收敛防跨租户）。spec id-only 端点专用。 */
  getById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    return this.store.listCodeGraphs(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countCodeGraphs(serviceId, teamId, opts);
  }

  /** Id-only management route entry point, including a safe cleanup retry. */
  deleteById(serviceId: string, codeGraphId: string): Promise<boolean> {
    const row = this.store.getCodeGraphById(serviceId, codeGraphId);
    const teamId = row?.team_id ?? this.pendingCleanup.get(`${serviceId}\0${codeGraphId}`);
    return teamId ? this.delete(serviceId, teamId, codeGraphId) : Promise.resolve(false);
  }

  hasPendingCleanup(serviceId: string, codeGraphId: string): boolean {
    return this.pendingCleanup.has(`${serviceId}\0${codeGraphId}`);
  }

  isBuildBusy(codeGraphId: string): boolean {
    return this.deleting.has(codeGraphId) || this.queue.isBusy(codeGraphId);
  }

  /**
   * 删除 code-graph（008 / 007 §5.5）。若该资产正在构建或有在途查询，
   * 立即返回 false，调用方可重试。成功仅表示元数据已硬删；磁盘目录在持有
   * 查询 gate 的后台任务中清理。已有硬删记录可安全重试未完成的磁盘清理。
   */
  async delete(serviceId: string, teamId: string, codeGraphId: string): Promise<boolean> {
    // Panel's KS request times out after 15s. Leave time for SQLite's 5s
    // busy timeout and the response after a slow handle close.
    const commitDeadline = Date.now() + 8_000;
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    const key = `${serviceId}\0${codeGraphId}`;
    const retryPending = !row && this.pendingCleanup.get(key) === teamId;
    if (!row && !retryPending) return false;
    // Metadata is already gone; an existing cleanup job needs no second writer.
    if (retryPending && this.cleanupJobs.has(key)) return true;
    // A queued delete could run after the caller's HTTP timeout, silently
    // removing metadata without the Panel/Core cascade. Reject instead.
    if (this.isBuildBusy(codeGraphId)) return false;

    this.deleting.add(codeGraphId);
    try {
      // The queue reserves this id against a newly admitted build. It is idle
      // now, so this job starts immediately and never waits behind a worker.
      return await this.queue.enqueueAndWait(codeGraphId, async () => {
        const current = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
        if (!current && this.pendingCleanup.get(key) !== teamId) return false;
        const result = await this.cleanupResources(serviceId, teamId, codeGraphId, commitDeadline);
        if (result.rowDeleted && current) this.audit(current, "delete", null);
        // A retry after a committed hard delete succeeds even if its async
        // file cleanup has to wait for a later idle window or restart sweep.
        return result.rowGone || retryPending;
      });
    } finally {
      this.deleting.delete(codeGraphId);
    }
  }

  /**
   * Commit the metadata deletion while queries are excluded, then remove
   * files in the background. The query gate stays held until removal ends.
   * If the database delete fails, the canonical directory remains intact.
   * BuildQueue 排队任务由 runBuild 入口检查行是否存在，无需在此处理。
   */
  private async cleanupResources(serviceId: string, teamId: string, codeGraphId: string, commitDeadline = Number.POSITIVE_INFINITY): Promise<{
    rowDeleted: boolean; rowGone: boolean;
  }> {
    const failed = { rowDeleted: false, rowGone: false };
    let resume: (() => void) | undefined;
    try {
      const acquired = await this.releaseInstance?.(codeGraphId);
      if (acquired === null) return failed;
      resume = acquired;
    } catch (err) {
      this.logger?.warn?.(`[code-graph] release instance failed ${codeGraphId}: ${String(err)}`);
      return failed;
    }
    try {
      if (Date.now() >= commitDeadline) {
        this.logger?.warn?.(`[code-graph] delete admission expired before metadata commit ${codeGraphId}`);
        return failed;
      }
      let rowDeleted: boolean;
      try {
        rowDeleted = this.store.deleteCodeGraph(serviceId, teamId, codeGraphId);
        // A second cleanup after a successful delete is idempotent. A false
        // result with a live row means the database refused this deletion.
        if (!rowDeleted && this.store.getCodeGraphById(serviceId, codeGraphId)) return failed;
      } catch (err) {
        this.logger?.warn?.(`[code-graph] hard-delete row failed ${codeGraphId}: ${String(err)}`);
        return failed;
      }

      const key = `${serviceId}\0${codeGraphId}`;
      this.pendingCleanup.set(key, teamId);
      const releaseGate = resume;
      resume = undefined;
      const cleanup = this.removeFiles(serviceId, teamId, codeGraphId)
        .then((removed) => {
          if (removed) this.pendingCleanup.delete(key);
        })
        .catch((err) => {
          this.logger?.warn?.(`[code-graph] file cleanup failed ${codeGraphId}: ${String(err)}`);
        })
        .finally(() => {
          try { releaseGate?.(); }
          catch (err) { this.logger?.warn?.(`[code-graph] release delete gate failed ${codeGraphId}: ${String(err)}`); }
          this.cleanupJobs.delete(key);
        });
      this.cleanupJobs.set(key, cleanup);
      return { rowDeleted, rowGone: true };
    } finally {
      resume?.();
    }
  }

  private async removeFiles(serviceId: string, teamId: string, codeGraphId: string): Promise<boolean> {
    let filesRemoved = true;
    const assetDir = this.dirFor(serviceId, teamId, codeGraphId);
    for (const target of [assetDir, `${assetDir}.previous`, `${assetDir}.suspect`]) {
      try { await rm(target, { recursive: true, force: true }); }
      catch (err) {
        filesRemoved = false;
        this.logger?.warn?.(`[code-graph] rm dir failed ${codeGraphId}: ${String(err)}`);
      }
    }
    const parent = dirname(assetDir);
    const prefix = `.${basename(assetDir)}.candidate-`;
    try {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        try { await rm(join(parent, entry.name), { recursive: true, force: true }); }
        catch (err) {
          filesRemoved = false;
          this.logger?.warn?.(`[code-graph] rm candidate dir failed ${codeGraphId}: ${String(err)}`);
        }
      }
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        filesRemoved = false;
        this.logger?.warn?.(`[code-graph] scan candidate dirs failed ${codeGraphId}: ${String(err)}`);
      }
    }
    return filesRemoved;
  }

  /**
   * worker 检查点：元数据行不在库即已删除。硬删在删盘之前完成。
   */
  private isDeleted(serviceId: string, codeGraphId: string): boolean {
    return this.store.getCodeGraphById(serviceId, codeGraphId) === null;
  }

  /** 写一条 code-graph 审计记录。失败不阻断主流程。 */
  private audit(row: CodeGraphRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendCodeGraphAudit({
        service_id: row.service_id,
        asset_id: row.code_graph_id,
        version: row.version,
        action,
        // 优先记录触发者（sync/create 的发起人），回退到行上的创建者。
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] audit ${action} failed: ${String(err)}`);
    }
  }

  private enqueueBuild(row: CodeGraphRow, hadReadyIndex = false, preserveUntrustedCanonical = false): void {
    this.queue.enqueue(row.code_graph_id, async () => {
      try {
        await this.runBuild(row.service_id, row.code_graph_id, row.team_id, row.repo_url, row.branch, hadReadyIndex, preserveUntrustedCanonical);
      } catch (err) {
        // The queue intentionally swallows rejected jobs. A persistent store
        // outage may prevent even the failed status from being written.
        this.logger?.error?.(`[code-graph] ${row.code_graph_id} build escaped with unrecorded error: ${String(err)}`);
        throw err;
      }
    });
  }

  private async runBuild(
    serviceId: string,
    codeGraphId: string,
    teamId: string,
    repoUrl: string,
    branch: string,
    hadReadyIndex: boolean,
    preserveUntrustedCanonical: boolean,
  ): Promise<void> {
    let result: CodeGraphBuildResult | undefined;
    let committed = false;
    try {
      // Include the initial status write in the failure path. Otherwise a
      // transient SQLite error leaves a pending row with no queued worker.
      if (this.isDeleted(serviceId, codeGraphId)) {
        await this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "processing",
        internal_status: "cloning",
        sync_error: null,
      });
      result = await this.worker({
        codeGraphId,
        serviceId,
        teamId,
        repoUrl,
        branch,
        dir: this.dirFor(serviceId, teamId, codeGraphId),
        hadReadyIndex,
        preserveUntrustedCanonical,
        setInternalStatus: (s) =>
          this.store.updateCodeGraphStatus(serviceId, codeGraphId, { status: "processing", internal_status: s }),
      });
      // 结束前检查点：processing 期间被删 → 跳过 ready/audit/回调，做幂等收尾清理。
      if (this.isDeleted(serviceId, codeGraphId)) {
        await this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        commit_hash: result.commitHash ?? null,
        stats_json: result.stats ? JSON.stringify(result.stats) : null,
        has_last_good: true,
        last_sync_at: new Date().toISOString(),
      });
      committed = true;
      try { await result.finalize?.(); }
      catch (err) { this.logger?.warn?.(`[code-graph] ${codeGraphId} previous snapshot cleanup failed: ${String(err)}`); }
      const synced = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (synced) {
        this.audit(synced, "ready", result.stats ? JSON.stringify(result.stats) : null);
      }
      this.logger?.info?.(`[code-graph] ${codeGraphId} ready`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, result.stats ?? null);
    } catch (err) {
      if (committed) {
        this.logger?.warn?.(`[code-graph] ${codeGraphId} post-build hook failed after commit: ${String(err)}`);
        return;
      }
      // worker 抛错，但若期间已被删，视为取消而非失败：跳过 failed 状态/回调，做清理。
      if (this.isDeleted(serviceId, codeGraphId)) {
        await this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      let failure: unknown = err;
      if (result?.rollback) {
        try {
          await result.rollback();
          failure = new PreservedCodeGraphError(err);
        } catch (rollbackError) {
          failure = new AggregateError([err, rollbackError], "CodeGraph metadata commit and rollback both failed");
        }
      }
      const msg = failure instanceof Error ? failure.message : String(failure);
      const preserved = hadReadyIndex && failure instanceof PreservedCodeGraphError;
      // The phase is recovery evidence. A failed copy with a stale retired
      // .previous must not look like an uncommitted promotion after restart.
      const failedPhase = this.store.getCodeGraphById(serviceId, codeGraphId)?.internal_status ?? null;
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: preserved ? "ready" : "failed",
        internal_status: preserved ? null : failedPhase,
        sync_error: msg.slice(0, 500),
      });
      const rowAfterRefresh = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (rowAfterRefresh) this.audit(rowAfterRefresh, preserved ? "refresh_failed" : "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[code-graph] ${codeGraphId} refresh failed${preserved ? " (previous index retained)" : ""}: ${msg}`);

      // TMC should see the same serving status as the store. Do not replace the
      // last successful summary with one computed from missing refresh stats.
      await this.onBuildComplete(rowAfterRefresh, preserved ? "ready" : "failed", msg, null, !preserved, preserved ? "refresh_failed" : undefined);
    }
  }

  /**
   * worker 检查点判定“已删”后的收尾：幂等清理 worker 可能刚写下的盘/句柄，
   * 硬删完成后 worker 仍可能写过磁盘，所以再次清理。
   */
  private async finishCancelled(serviceId: string, teamId: string, codeGraphId: string): Promise<void> {
    const result = await this.cleanupResources(serviceId, teamId, codeGraphId);
    if (result.rowGone) await this.cleanupJobs.get(`${serviceId}\0${codeGraphId}`);
    else this.logger?.warn?.(`[code-graph] ${codeGraphId} deleted build cleanup deferred until restart`);
    this.logger?.info?.(`[code-graph] ${codeGraphId} build aborted (deleted during processing)`);
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: CodeGraphRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    stats: { files: number; nodes: number; edges: number } | null,
    generateSummary = true,
    event?: "refresh_failed",
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready" && generateSummary) {
      // Generate summary via template (no LLM for code-graph)
      const { generateCodeGraphSummary } = await import("../callback.js");
      summary = generateCodeGraphSummary(row.repo_name || row.repo_url, row.branch, stats);
      if (summary) {
        this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { summary });
      }
    } else if (status === "ready") {
      summary = row.summary;
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.code_graph_id,
        service_id: row.service_id,
        type: "code-graph",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(event ? { event } : {}),
      },
      this.callbackConfig,
    );
  }

  /** 等待后台任务完成（测试 / 停机）。 */
  async onIdle(codeGraphId?: string): Promise<void> {
    await this.queue.onIdle(codeGraphId);
    const jobs = [...this.cleanupJobs]
      .filter(([key]) => !codeGraphId || key.endsWith(`\0${codeGraphId}`))
      .map(([, job]) => job);
    await Promise.all(jobs);
  }
}
