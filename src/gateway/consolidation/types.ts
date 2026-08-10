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
 * NIGHT_SWEEP_LIMIT is exported here because it is shared between the
 * batching strategies. DEFAULT_ROLE_PROMPT and DEFAULT_TASK_PROMPT live in
 * prompt-builder.ts.
 */

import type { GatewayConfig } from "../config.js";
import type { Logger } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { ApplyResult } from "../apply-executor.js";
import type { ChildRunResult } from "./child-spawn.js";
import type { ProbeResult } from "../probe.js";
import type {
  LauncherDefaults,
  ResolvedRoleContract,
  RoleLegacyDefaults,
} from "./role-contract-types.js";

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
  /** Resolved contract of that role — the launcher reads model/thinking/
   * timeout/assets from here, never from the global config (tz-01 B5). */
  contract: ResolvedRoleContract;
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

// `resolveRoleTimeoutMs` is gone (tz-01 B1): it was a SECOND reader of
// role.json alongside the role runtime, which the "one resolver" requirement
// forbids. The per-run timeout now comes from
// `ResolvedRoleContract.timeoutMs`, and its behaviour (role `timeout_min`
// wins over the global fallback) is covered in role-contract.test.ts.

export interface OrchestratorOptions {
  config: GatewayConfig;
  /** Global fallbacks for the LegacyRoleAdapter + host launch parameters.
   * Built by the composition root so no module under consolidation/ reads
   * `config.memory.consolidation.*` for a role parameter (tz-01 criterion 7). */
  roleDefaults: RoleLegacyDefaults;
  launcher: LauncherDefaults;
  /** Consolidation master switch (`memory.consolidation.enabled`), resolved
   * by the caller so the read does not live on the role path. */
  enabled: boolean;
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
