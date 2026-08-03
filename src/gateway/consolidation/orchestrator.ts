/**
 * ConsolidationOrchestrator (P6) — slim shim.
 *
 * Holds the OrchestratorContext (deps + state refs) and delegates to
 * module-level functions:
 *   - start/stop/trigger/runNow → triggers.ts
 *   - executeRun → day-runner.ts (single batch) or night-runner.ts
 *     (multi-batch, anchored cursor, cap accumulation)
 * Pipeline helpers (runBatch, writeReport, queryRecentRecords, etc.) live
 * in their own files (runner.ts, queries.ts, reports.ts, runner-helpers.ts,
 * prompt-builder.ts, runner-stages.ts).
 */

import { randomUUID } from "node:crypto";
import { ConsolidationCheckpoint } from "./checkpoint.js";
import { RoleGate } from "./role-gate.js";
import { busySummary } from "./busy-summary.js";
import {
  start as startLifecycle,
  stop as stopLifecycle,
  trigger as triggerLifecycle,
  runNow as runNowLifecycle,
} from "./triggers.js";
import { handleFromCtx } from "./handle-from-ctx.js";
import { executeRunDay } from "./day-runner.js";
import { executeRunNight } from "./night-runner.js";
import { defaultSpawnChild, defaultApplyDiff } from "./runner-helpers.js";
import { resolveRoleDir } from "../role-files.js";
import { resolveKeeperToolsDir as resolveKeeperToolsDirHelper } from "./keeper-tools.js";
import type {
  OrchestratorOptions,
  RunSummary,
  TriggerResult,
} from "./types.js";
import type { OrchestratorContext } from "./context.js";

export { resolveRoleTimeoutMs, NIGHT_SWEEP_LIMIT } from "./types.js";
export {
  buildSessionPrompt,
  DEFAULT_ROLE_PROMPT,
  DEFAULT_TASK_PROMPT,
} from "./prompt-builder.js";
export type {
  RunSummary,
  TriggerResult,
  SpawnChildContext,
  SpawnChildFn,
  ApplyDiffFn,
  OrchestratorOptions,
  ChildSummary,
} from "./types.js";
export class ConsolidationOrchestrator {
  /** Static delegate for tests that probe resolveKeeperToolsDir. */
  static resolveKeeperToolsDir(): string | null {
    return resolveKeeperToolsDirHelper();
  }

  private readonly ctx: OrchestratorContext;

  constructor(opts: OrchestratorOptions) {
    this.ctx = {
      config: opts.config,
      dataDir: opts.dataDir,
      scratchRoot: opts.scratchRoot,
      logger: opts.logger,
      gatewayUrl: opts.gatewayUrl,
      vectorStore: opts.vectorStore,
      embeddingService: opts.embeddingService,
      now: opts.now ?? (() => Date.now()),
      spawnChild: opts.spawnChild ?? ((c) => defaultSpawnChild(this.ctx, c)),
      applyDiff: opts.applyDiff ?? ((b) => defaultApplyDiff(this.ctx, b)),
      roleName: opts.roleName ?? "memory-keeper",
      roleDir: opts.roleDir ?? resolveRoleDir(),
      ownerPid: process.pid,
      checkpoint: new ConsolidationCheckpoint(opts.dataDir),
      gate: new RoleGate(),
      activeRunUuidRef: { value: new Set<string>() },
      childrenRef: { value: new Map<string, { kill: () => unknown }>() },
      lastRunRef: { value: null },
    };
  }

  /** Snapshot of the consolidation checkpoint (night-run threshold needs it). */
  readCheckpoint(): Promise<{
    l0Cursor: string;
    lastRunAt: string | null;
    l0Count: number;
    roles: Record<string, unknown>;
  }> {
    return this.ctx.checkpoint.read() as Promise<{
      l0Cursor: string;
      lastRunAt: string | null;
      l0Count: number;
      roles: Record<string, unknown>;
    }>;
  }

  /** Absolute path of the consolidation checkpoint file. */
  get checkpointFile(): string {
    return this.ctx.checkpoint.file;
  }

  get isRunning(): boolean {
    return this.ctx.gate.isLocked;
  }

  /** Last run summary (in-memory snapshot; also read from logs on start). */
  getLastRun(): RunSummary | null {
    return this.ctx.lastRunRef.value;
  }

  async trigger(opts: {
    reason: string;
    dryRun?: boolean;
    runType?: string;
  }): Promise<TriggerResult> {
    return triggerLifecycle(handleFromCtx(this.ctx), opts);
  }

  async runNow(opts: {
    reason: string;
    dryRun?: boolean;
    runType?: string;
  }): Promise<RunSummary> {
    return runNowLifecycle(handleFromCtx(this.ctx), opts);
  }

  async start(): Promise<void> {
    await startLifecycle(handleFromCtx(this.ctx));
  }
  async stop(): Promise<void> {
    await stopLifecycle(handleFromCtx(this.ctx));
  }

  /** Dispatch to day or night runner based on role. */
  async executeRun(opts: {
    reason: string;
    dryRun?: boolean;
    runId?: string;
    role: string;
  }): Promise<RunSummary> {
    const runId = opts.runId ?? randomUUID();
    return opts.role === "night-keeper"
      ? executeRunNight(this.ctx, { ...opts, runId })
      : executeRunDay(this.ctx, { ...opts, runId });
  }
}

// Re-export busySummary (gate-refused shape, tests compare against it).
export { busySummary };
