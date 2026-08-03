/**
 * Public types + constants for the consolidation orchestrator (P6).
 *
 * RunSummary: report contract (server.ts /status reads lastRun + probe).
 * TriggerResult: 202-style accepted/busy/disabled response.
 * SpawnChildFn / ApplyDiffFn: injectable seams for tests (real spawn is
 * only in production, never in unit tests).
 * OrchestratorOptions: constructor args (lazy store accessors — the
 * gateway stores initialize AFTER the orchestrator is constructed).
 *
 * NIGHT_SWEEP_LIMIT + resolveRoleTimeoutMs are also exported here because
 * they're shared between day and night runs. DEFAULT_ROLE_PROMPT and
 * DEFAULT_TASK_PROMPT live in prompt-builder.ts.
 */

import type { GatewayConfig } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { ApplyResult } from "../apply-executor.js";
import { loadRoleConfig } from "../role-files.js";
import type { ChildRunResult } from "./child-spawn.js";
import type { ProbeResult } from "../probe.js";

export interface ChildSummary {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface RunSummary {
  role: string;
  status: "ok" | "failed" | "aborted" | "dry-run" | "disabled";
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  reason: string;
  dryRun: boolean;
  newL0: number;
  recordsPresented: number;
  overLimitBlocks: number;
  applied: { merges: string[]; deletes: string[]; rewrites: string[] };
  skipped: { merges: string[]; deletes: string[]; rewrites: string[] };
  error?: string;
  reindexed: boolean;
  needsReindex: boolean;
  child?: ChildSummary;
  /** Recall-quality probe result (P10, #1) — attached to every real run. */
  probe?: ProbeResult;
}

export interface TriggerResult {
  /** False when the trigger was refused (busy / disabled). */
  accepted: boolean;
  status: "started" | "busy" | "disabled";
  runId?: string;
  reason: string;
}

export interface SpawnChildContext {
  runId: string;
  /** Per-run scratch dir (<scratchRoot>/<runId>) — cwd of the sub-session. */
  scratchDir: string;
  /** Session prompt file path (role prompt + diff section). */
  promptPath: string;
  taskPrompt: string;
  env: Record<string, string>;
  cwd: string;
  /** Effective role for this run (runType ?? constructor roleName). */
  role: string;
}

export type SpawnChildFn = (ctx: SpawnChildContext) => Promise<ChildRunResult>;
export type ApplyDiffFn = (body: unknown) => Promise<ApplyResult>;

/**
 * Night full-store sweep bound. Per-batch apply presents ≤ night.diffCap ids
 * (≤ 200), so the per-apply zod cap MAX_PRESENTED_IDS=5000 no longer limits
 * the sweep; 25_000 rows ≈ 25 MB materialized content, acceptable. Beyond
 * that the store needs the documented multi-batch loop (already present).
 */
export const NIGHT_SWEEP_LIMIT = 25_000;

/**
 * Effective per-run timeout: the role-file `timeout_min` (minutes) of the
 * PER-RUN role wins over the consolidation fallback. Positive `timeout_min`
 * only; missing/zero file or config → fallbackMs. One source per batch,
 * never mixed (night runs resolve night-keeper.json, not the day one).
 */
export function resolveRoleTimeoutMs(
  role: string,
  roleDir: string | null | undefined,
  fallbackMs: number,
): number {
  // Lenient read — the role file may be minimal ({name, timeout_min}): tests
  // and legacy configs don't carry the full 19-field strict schema. Search
  // canonical per-role, bare flat, then legacy memory-keeper layout.
  const candidates = [
    path.join(roleDir ?? "", role, "role.json"),
    path.join(roleDir ?? "", `${role}.json`),
    path.join(roleDir ?? "", "memory-keeper", `${role}.json`),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const t = (JSON.parse(fs.readFileSync(p, "utf-8")) as { timeout_min?: unknown })
        ?.timeout_min;
      return typeof t === "number" && t > 0 ? t * 60_000 : fallbackMs;
    } catch {
      return fallbackMs;
    }
  }
  return fallbackMs;
}

export interface OrchestratorOptions {
  config: GatewayConfig;
  dataDir: string;
  /** Scratch root OUTSIDE the memory tree — per-run subdirs live here. */
  scratchRoot: string;
  logger: Logger;
  /** Loopback gateway URL passed to the child (TDAI_GATEWAY_URL). */
  gatewayUrl: string;
  /** Lazy store accessors — the gateway stores initialize AFTER the
   * orchestrator is constructed, so instances are fetched at apply time. */
  vectorStore?: () => IMemoryStore | undefined;
  embeddingService?: () => EmbeddingService | undefined;
  /** Injectable clock (tests use a fixed one). */
  now?: () => number;
  /** Injectable spawner (tests mock it — never spawn a real pi session). */
  spawnChild?: SpawnChildFn;
  /** Injectable applier (tests may stub the P4 executor). */
  applyDiff?: ApplyDiffFn;
  roleName?: string;
  /** Role dir override (tests point at a scratch dir; default resolveRoleDir()). */
  roleDir?: string;
}
