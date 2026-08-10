/**
 * The seam between the shared run shell (run-role.ts) and a batching
 * strategy: the shell owns everything that does NOT depend on the strategy
 * (scratch dir, checkpoint, newL0, block metadata, report, cleanup), the
 * strategy owns record selection, spawning and the advance decision.
 */
import type { OrchestratorContext } from "./context.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";
import type { RunSummary } from "./types.js";
import type { BlockMeta } from "./diff-builder.js";

export interface RunRoleOpts {
  reason: string;
  dryRun?: boolean;
  runId: string;
  role: string;
  contract: ResolvedRoleContract;
}

export interface StrategyInput {
  ctx: OrchestratorContext;
  opts: RunRoleOpts;
  /** Scratch dir of THIS run (already resolved from the contract assets). */
  runScratch: string;
  cp: { l0Cursor: string; lastRunAt: string | null };
  blocks: BlockMeta[];
  summary: RunSummary;
  startedMs: number;
}

export interface StrategyOutcome {
  /** Diff text for the dry-run report (never applied). */
  diffText?: string;
  /** Present only when the cursor may move. `anchor: undefined` means "past
   * the fresh tail"; a string pins the advance to that slice-time. */
  advance?: { anchor: string | undefined };
}
