/** Skill-only agent queue consumer. Archive extraction and durable restructure
 * operations share scheduling/lease protection, never each other's payloads. */
import type { AgentTuple, ExtractLockHandle, ISkillAgentTaskQueue } from "./agent-task-queue.js";
import type { SkillBufferStorage, SkillDeadTaskEntry, SkillExtractTaskEntry, SkillTaskEntry } from "./buffer-storage.js";
import type { ExtractedCandidate, ExtractorLogger, ISkillExtractor, SkillRestructureProcessor } from "../queue/types.js";
import type { SkillRestructureOperation } from "../skill-restructure-types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import { trace } from "../../report/trace.js";

export interface SkillCandidatesSink {
  applyCandidates(input: {
    task: SkillExtractTaskEntry;
    candidates: ExtractedCandidate[];
    workerId: string;
    abortSignal?: AbortSignal;
  }): Promise<void>;
}

export interface SkillConversationExtractWorkerOptions {
  workerId: string;
  buffer: SkillBufferStorage;
  queue: ISkillAgentTaskQueue;
  /** Existing eager injections remain supported. Restructure does not need either. */
  extractor?: ISkillExtractor;
  sink?: SkillCandidatesSink;
  resolveExtractor?: () => Promise<ISkillExtractor>;
  resolveSink?: () => Promise<SkillCandidatesSink>;
  processRestructure?: SkillRestructureProcessor;
  logger: ExtractorLogger;
  brpopBlockMs?: number;
  extractLockTtlMs?: number;
  extractLockRenewIntervalMs?: number;
  tasksMutexLockTtlMs?: number;
  tasksMutexWaitDeadlineMs?: number;
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  tasksPerRound?: number;
  now?: () => number;
  failureRequeueSleepMs?: number;
  /** Legacy permanent extraction errors; transient extraction remains retryable. */
  permanentMaxRetries?: number;
  /** All retryable restructure attempts, including busy/unknown. Default 8. */
  restructureMaxRetries?: number;
  transientLogSampleEvery?: number;
}

export interface SkillAgentConsumeResult {
  agent: AgentTuple;
  processedTaskIds: string[];
  lockContended?: boolean;
  dropped?: string[];
  cancelled?: boolean;
}

export class SkillTaskProcessingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly terminal = false,
  ) {
    super(`${code}: ${message}`);
    this.name = "SkillTaskProcessingError";
  }
}

function cancellation(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError", code: "SKILL_WORKER_ABORTED", retryable: true });
}

export class SkillConversationExtractWorker {
  private readonly opts: SkillConversationExtractWorkerOptions;
  private readonly logger: ExtractorLogger;
  private closed = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;
  private readonly controllers = new Set<AbortController>();
  private readonly activeRuns = new Set<Promise<SkillAgentConsumeResult>>();
  private readonly transientFailStreak = new Map<string, number>();

  constructor(opts: SkillConversationExtractWorkerOptions) {
    if (opts.restructureMaxRetries !== undefined && (!Number.isSafeInteger(opts.restructureMaxRetries) || opts.restructureMaxRetries < 1)) {
      throw new Error("restructureMaxRetries must be a positive finite integer");
    }
    this.opts = opts;
    this.logger = opts.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    this.logger.info(`[skill-conv-worker] start id=${this.opts.workerId} brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`);
    this.loopPromise = runInRootContext(() => this.runLoop());
    this.loopPromise.catch(() => { /* logged by runLoop */ });
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(cancellation("skill worker stopped"));
    await Promise.allSettled([...this.activeRuns]);
    if (this.loopPromise) {
      try { await this.loopPromise; } catch { /* logged by runLoop */ }
    }
  }

  async runOnce(): Promise<Omit<SkillAgentConsumeResult, "agent"> & { agent?: AgentTuple }> {
    const agent = await this.opts.queue.peekAgent(this.opts.brpopBlockMs ?? 5000);
    return agent ? this.consumeAgent(agent) : { processedTaskIds: [] };
  }

  private async runLoop(): Promise<void> {
    while (!this.closed) {
      try {
        const agent = await this.opts.queue.peekAgent(this.opts.brpopBlockMs ?? 5000);
        if (agent && !this.closed) await this.consumeAgent(agent);
      } catch (err) {
        if (this.closed) break;
        this.logger.error(`[skill-conv-worker] consume/peek error: ${errorMessage(err)}`);
        await sleep(200);
      }
    }
  }

  consumeAgent(agent: AgentTuple, signal?: AbortSignal): Promise<SkillAgentConsumeResult> {
    const controller = new AbortController();
    const relay = () => controller.abort(signal?.reason ?? cancellation("skill task cancelled"));
    if (signal?.aborted) relay();
    else signal?.addEventListener("abort", relay, { once: true });
    if (this.closed) controller.abort(cancellation("skill worker stopped"));
    this.controllers.add(controller);
    const startedAt = Date.now();
    const running = this.consumeWithLease(agent, controller).then(result => {
      obsLogger.info("skill.worker.consume_done", { worker_id: this.opts.workerId, instance_id: agent.instance_id,
        agent_key: `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`,
        outcome: result.cancelled ? "cancelled" : result.lockContended ? "lock_contended" : "ok",
        processed: result.processedTaskIds.length, dropped: result.dropped?.length ?? 0, dur_ms: Date.now() - startedAt });
      return result;
    }).finally(() => {
      signal?.removeEventListener("abort", relay);
      this.controllers.delete(controller);
      this.activeRuns.delete(running);
    });
    this.activeRuns.add(running);
    return running;
  }

  private async consumeWithLease(agent: AgentTuple, controller: AbortController): Promise<SkillAgentConsumeResult> {
    const q = this.opts.queue;
    const signal = controller.signal;
    const ttl = this.opts.extractLockTtlMs ?? 600_000;
    const mutexOpts = { lockTtlMs: this.opts.tasksMutexLockTtlMs ?? 10_000, waitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs ?? 30_000 };
    const isDowngrade = (typeof q.getPeekStrategy === "function" ? q.getPeekStrategy() : "lmove") === "rpop_lpush_downgrade";
    const processedTaskIds: string[] = [], dropped: string[] = [];
    const workerId = this.opts.workerId;
    const agentKey = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
    let handle: ExtractLockHandle | null = null;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    let renewing: Promise<void> | undefined;
    let unhandledFailure = false;
    const stopRenewal = () => { if (renewTimer) clearInterval(renewTimer); renewTimer = undefined; };
    signal.addEventListener("abort", stopRenewal, { once: true });

    // Used immediately before side effects as well as by the background timer.
    // Redis/COS are not one transaction: an already in-flight storage request
    // cannot be recalled. Cancellation prevents starting subsequent writes/acks.
    const ensureLease = async (): Promise<void> => {
      signal.throwIfAborted();
      if (!handle) throw cancellation("extract lease unavailable");
      if (!renewing) {
        const lock = handle;
        renewing = (async () => {
          try {
            if (!(await q.renewExtractLock(lock, ttl))) {
              controller.abort(cancellation("extract lease lost"));
              this.logger.warn(`[skill-conv-worker] renew extract-lock lost agent=${agentKey}`);
            }
          } catch (err) {
            controller.abort(cancellation(`extract lease renewal failed: ${errorMessage(err)}`));
            this.logger.warn(`[skill-conv-worker] renew extract-lock error: ${errorMessage(err)}`);
          }
        })().finally(() => { renewing = undefined; });
      }
      await renewing;
      signal.throwIfAborted();
    };

    try {
      signal.throwIfAborted();
      obsLogger.info("skill.worker.consume_start", { worker_id: workerId, agent_key: agentKey, instance_id: agent.instance_id });
      this.logger.info(`[skill-conv-worker] dequeued agent=${agentKey}`);
      const lockStarted = Date.now();
      handle = await q.acquireExtractLock(agent, ttl);
      obsLogger.info("skill.worker.acquire_lock", { worker_id: workerId, agent_key: agentKey, instance_id: agent.instance_id,
        acquired: !!handle, dur_ms: Date.now() - lockStarted });
      signal.throwIfAborted();
      if (!handle) {
        if (isDowngrade) await q.requeueAgent(agent);
        const jitter = Math.floor(Math.random() * (this.opts.lockContentionSleepJitterMs ?? 500));
        await sleep((this.opts.lockContentionSleepMs ?? 2000) + jitter, signal);
        return { agent, processedTaskIds, lockContended: true };
      }
      this.logger.info(`[skill-conv-worker] acquired extract-lock agent=${agentKey}`);
      const interval = this.opts.extractLockRenewIntervalMs ?? Math.floor(ttl / 4);
      if (interval > 0) renewTimer = setInterval(() => { void ensureLease().catch(() => { /* signal carries lease loss */ }); }, interval);

      for (let round = 0; round < (this.opts.tasksPerRound ?? 1); round++) {
        signal.throwIfAborted();
        const readStarted = Date.now();
        const head = await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          await ensureLease(); signal.throwIfAborted();
          const first = doc.tasks[0] ?? null;
          if (!first) await q.removeAgent(agent);
          return first;
        });
        obsLogger.info("skill.worker.read_head", { worker_id: workerId, agent_key: agentKey, instance_id: agent.instance_id,
          has_head: !!head, dur_ms: Date.now() - readStarted });
        if (!head) return { agent, processedTaskIds, dropped };
        const started = Date.now();
        let candidates: ExtractedCandidate[] | null = null;
        let isGhost = false;
        let restructure: SkillRestructureOperation | undefined;
        obsLogger.info("skill.worker.task_start", { worker_id: workerId, task_id: head.task_id,
          instance_id: agent.instance_id, kind: head.kind ?? "extract" });

        try {
          if (head.kind === "restructure") {
            if (!this.opts.processRestructure) throw new SkillTaskProcessingError("SKILL_RESTRUCTURE_PENDING", `operation_id=${head.operation_id}; processor unavailable`, true);
            await ensureLease(); signal.throwIfAborted();
            restructure = await this.opts.processRestructure(head.operation_id, signal);
            await ensureLease(); signal.throwIfAborted();
            if (restructure.operation_id !== head.operation_id) {
              throw new SkillTaskProcessingError("SKILL_RESTRUCTURE_RESULT_INVALID", `operation_id=${head.operation_id}; mismatched processor response`, false, true);
            }
            const outputIds = restructure.outputs.map(output => output.skill_id).join(",");
            this.logger.info(`[skill-conv-worker] restructure operation=${head.operation_id} status=${restructure.status} outputs=${outputIds}`);
            obsLogger.info("skill.worker.restructure", { worker_id: workerId, task_id: head.task_id,
              instance_id: agent.instance_id, operation_id: head.operation_id, status: restructure.status, output_ids: outputIds });
            if (["queued", "running", "prepared", "publishing"].includes(restructure.status)) {
              throw new SkillTaskProcessingError("SKILL_RESTRUCTURE_PENDING", `operation_id=${head.operation_id} status=${restructure.status}`, true);
            }
            if (restructure.status !== "succeeded" && restructure.status !== "unchanged") {
              throw new SkillTaskProcessingError(restructure.error?.code ?? "SKILL_RESTRUCTURE_FAILED",
                `operation_id=${head.operation_id} status=${restructure.status}: ${restructure.error?.message ?? "terminal operation failure"}`, false, true);
            }
          } else {
            this.logger.info(`[skill-conv-worker] processing task_id=${head.task_id} archive_key=${head.archive_key}`);
            const archiveStarted = Date.now();
            const archive = await this.opts.buffer.readArchive(head.archive_key);
            signal.throwIfAborted();
            obsLogger.info("skill.worker.read_archive", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
              found: !!archive, msg_count: archive?.messages?.length ?? 0, dur_ms: Date.now() - archiveStarted });
            if (!archive) {
              isGhost = true;
              this.logger.warn(`[skill-conv-worker] ghost task, dropping task_id=${head.task_id} archive_key=${head.archive_key}`);
              obsLogger.warn("skill.worker.ghost", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id, archive_key: head.archive_key });
            } else {
              const extractor = this.opts.extractor ?? await this.opts.resolveExtractor?.();
              signal.throwIfAborted();
              if (!extractor) throw new SkillTaskProcessingError("SKILL_EXTRACTOR_UNAVAILABLE", "extractor is not configured", true);
              await ensureLease(); signal.throwIfAborted();
              this.logger.info(`[skill-conv-worker] extract start task_id=${head.task_id} messages=${archive.messages?.length ?? 0}`);
              const extractStarted = Date.now();
              const result = await extractor.extract({ task_id: head.task_id, team_id: head.team_id, user_id: head.user_id,
                agent_id: head.agent_id, session_id: head.session_id, space_id: head.space_id,
                conversation: (archive.messages ?? []).map(message => ({ role: String(message.role ?? "user"), content: String(message.content ?? "") })),
                reason: head.reason, options: head.max_iterations != null ? { max_iterations: head.max_iterations } : undefined,
                mode: head.mode, signal, abortSignal: signal,
              });
              await ensureLease(); signal.throwIfAborted();
              candidates = result.candidates ?? [];
              this.logger.info(`[skill-conv-worker] extract done task_id=${head.task_id} candidates=${candidates.length}`);
              obsLogger.info("skill.worker.extractor", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
                candidates: candidates.length, msg_count: archive.messages?.length ?? 0, dur_ms: Date.now() - extractStarted });
              const sink = this.opts.sink ?? await this.opts.resolveSink?.();
              signal.throwIfAborted();
              if (!sink) throw new SkillTaskProcessingError("SKILL_EXTRACTOR_UNAVAILABLE", "candidate sink is not configured", true);
              await ensureLease(); signal.throwIfAborted();
              const sinkStarted = Date.now();
              await sink.applyCandidates({ task: head, candidates, workerId, abortSignal: signal });
              signal.throwIfAborted();
              obsLogger.info("skill.worker.apply_candidates", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
                candidates: candidates.length, dur_ms: Date.now() - sinkStarted });
            }
          }
        } catch (err) {
          if (signal.aborted) throw err;
          const message = errorMessage(err);
          const category = classifyError(err as Error);
          if (head.kind !== "restructure" && category === "transient") {
            this.logTransientFailure(head.task_id, message);
            await sleep(this.opts.failureRequeueSleepMs ?? 2000, signal);
            if (isDowngrade) { await ensureLease(); signal.throwIfAborted(); await q.requeueAgent(agent); }
          } else {
            this.transientFailStreak.delete(head.task_id);
            await sleep(this.opts.failureRequeueSleepMs ?? 2000, signal);
            const terminal = err instanceof SkillTaskProcessingError && err.terminal;
            const maxRetries = terminal ? 1 : head.kind === "restructure" && category === "transient"
              ? this.opts.restructureMaxRetries ?? 8 : this.opts.permanentMaxRetries ?? 3;
            const diagnostic = head.kind === "restructure"
              ? `operation_id=${head.operation_id} code=${errorCode(err) ?? "UNKNOWN"}: ${message}` : message;
            await this.persistFailure(agent, head, diagnostic, maxRetries, mutexOpts, isDowngrade, ensureLease, signal);
          }
          obsLogger.info("skill.worker.task_done", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
            outcome: head.kind === "restructure" ? "restructure_retry_or_dlq" : category === "transient" ? "retry_transient" : "dlq_or_retry",
            dur_ms: Date.now() - started });
          break;
        }

        // Read-modify-write and queue membership stay in the same tasks mutex.
        // Recheck after each await before starting a deletion/ack side effect.
        const deleteStarted = Date.now();
        const remaining = await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          await ensureLease(); signal.throwIfAborted();
          const before = doc.tasks.length;
          doc.tasks = doc.tasks.filter(task => task.task_id !== head.task_id);
          if (doc.tasks.length !== before) {
            doc.updated_at_ms = this.opts.now?.() ?? Date.now();
            await ensureLease(); signal.throwIfAborted();
            await this.opts.buffer.writeTasks(agent, doc);
          }
          signal.throwIfAborted();
          if (isDowngrade) {
            await ensureLease(); signal.throwIfAborted();
            if (doc.tasks.length) await q.requeueAgent(agent); else await q.removeAgent(agent);
          }
          return doc.tasks.length;
        });
        signal.throwIfAborted();
        obsLogger.info("skill.worker.delete_task", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
          remaining, dur_ms: Date.now() - deleteStarted });
        this.transientFailStreak.delete(head.task_id);
        const outcome = restructure?.status ?? (isGhost ? "ghost" : "ok");
        obsLogger.info("skill.worker.task_done", { worker_id: workerId, task_id: head.task_id, instance_id: agent.instance_id,
          outcome, candidates: candidates?.length ?? 0, dur_ms: Date.now() - started });
        try { trace.report("skill.worker.task_done", { task_id: head.task_id, instance_id: agent.instance_id,
          team_id: head.team_id, agent_id: head.agent_id, outcome, success: true, dur_ms: Date.now() - started }); } catch { /* telemetry only */ }
        if (isGhost) dropped.push(head.task_id); else processedTaskIds.push(head.task_id);
      }
      return { agent, processedTaskIds, dropped };
    } catch (err) {
      if (signal.aborted) {
        this.logger.warn(`[skill-conv-worker] cancelled agent=${agentKey}: ${errorMessage(signal.reason)}`);
        return { agent, processedTaskIds, dropped, cancelled: true };
      }
      unhandledFailure = true;
      throw err;
    } finally {
      stopRenewal(); signal.removeEventListener("abort", stopRenewal);
      // Non-atomic peek may have popped the scheduling signal. Restoring it is
      // safe even after cancellation; it does not acknowledge or modify a task.
      if (isDowngrade && (signal.aborted || unhandledFailure)) {
        try { await q.requeueAgent(agent); } catch (err) { this.logger.warn(`[skill-conv-worker] recovery requeue failed: ${errorMessage(err)}`); }
      }
      if (handle) {
        try { await q.releaseExtractLock(handle); } catch (err) { this.logger.warn(`[skill-conv-worker] releaseExtractLock error: ${errorMessage(err)}`); }
      }
    }
  }

  private logTransientFailure(taskId: string, message: string): void {
    const streak = (this.transientFailStreak.get(taskId) ?? 0) + 1;
    this.transientFailStreak.set(taskId, streak);
    const every = this.opts.transientLogSampleEvery ?? 60;
    if (streak === 1) this.logger.error(`[skill-conv-worker] transient extract failure task=${taskId}: ${message}`);
    else if (every > 0 && streak % every === 0) this.logger.warn(`[skill-conv-worker] transient extract failure (x${streak}) task=${taskId}: ${message}`);
  }

  private async persistFailure(
    agent: AgentTuple, head: SkillTaskEntry, message: string, maxRetries: number,
    mutexOpts: { lockTtlMs: number; waitDeadlineMs: number }, isDowngrade: boolean,
    ensureLease: () => Promise<void>, signal: AbortSignal,
  ): Promise<void> {
    const q = this.opts.queue;
    await q.withTasksMutex(agent, mutexOpts, async () => {
      const doc = await this.opts.buffer.readTasks(agent);
      await ensureLease(); signal.throwIfAborted();
      const index = doc.tasks.findIndex(task => task.task_id === head.task_id);
      if (index < 0) return;
      const current = doc.tasks[index];
      const nextRetry = (current.retry_count ?? 0) + 1;
      const failed: SkillTaskEntry = { ...current, retry_count: nextRetry, last_error: message.slice(0, 1024) };
      const now = this.opts.now?.() ?? Date.now();
      if (nextRetry >= Math.max(1, maxRetries)) {
        const dead: SkillDeadTaskEntry = { ...failed, dead_lettered_at_ms: now };
        await ensureLease(); signal.throwIfAborted();
        // Persist first. An append error (including an unknown acknowledgement)
        // leaves the original task; retrying appendDlq is task-id idempotent.
        await this.opts.buffer.appendDlq(agent, dead, signal);
        await ensureLease(); signal.throwIfAborted();
        doc.tasks.splice(index, 1);
      } else doc.tasks[index] = failed;
      doc.updated_at_ms = now;
      await ensureLease(); signal.throwIfAborted();
      await this.opts.buffer.writeTasks(agent, doc);
      signal.throwIfAborted();
      const log = `[skill-conv-worker] ${nextRetry >= Math.max(1, maxRetries) ? "DLQ" : "retry"} task=${head.task_id} retries=${nextRetry}/${maxRetries} ${failed.last_error}`;
      if (nextRetry >= Math.max(1, maxRetries)) this.logger.error(log); else this.logger.warn(log);
      if (isDowngrade) {
        await ensureLease(); signal.throwIfAborted();
        if (doc.tasks.length) await q.requeueAgent(agent); else await q.removeAgent(agent);
      }
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Structured service errors win over message heuristics. Legacy behavior for
 * unclassified extraction failures remains conservative/transient. */
export function classifyError(err: Error): "transient" | "permanent" {
  const retryable = (err as Error & { retryable?: boolean }).retryable;
  if (retryable === true) return "transient";
  if (["SKILL_RESTRUCTURE_PENDING", "SKILL_PUBLICATION_BUSY", "SKILL_PUBLICATION_UNKNOWN"].includes(errorCode(err) ?? "")) return "transient";
  if (retryable === false) return "permanent";
  if (err?.name === "AbortError") return "transient";
  const message = `${err?.name ?? ""} ${err?.message ?? ""}`.toLowerCase();
  if (/(^|[^\d])(400|422)([^\d]|$)/.test(message)) return "permanent";
  if (["json.parse", "unexpected token", "invalid json", "invalid response", "schema", "zod", "validation failed"].some(text => message.includes(text))) return "permanent";
  return "transient";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? cancellation("skill worker cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
