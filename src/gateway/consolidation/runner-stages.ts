/**
 * Pre-apply stages of the run-batch pipeline.
 *
 * Diff build → prompt write → tools copy → spawn → parse diff.json →
 * mechanical caps check. Pure orchestration — no mutations, no apply.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildManifestBaseline,
  buildDiffSection,
  maxL0RecordedAt,
  type ManifestBaseline,
} from "./diff-builder.js";
import { buildChildEnv, type ChildRunResult } from "./child-spawn.js";
import { DEFAULT_TASK_PROMPT, buildSessionPrompt as composeSessionPrompt } from "./prompt-builder.js";
import { copyKeeperTools } from "./runner-helpers.js";
import { truncate } from "./chunk.js";
import { checkCaps } from "./check-caps.js";
import type { OrchestratorContext } from "./context.js";
import type { NightConsolidationConfig } from "../../config.js";
import type { RunBatchArgs, RunBatchResult } from "./runner-types.js";

export interface PreApplyResult {
  ok: boolean;
  rawDiff?: unknown;
  baseline?: ManifestBaseline;
  presentedRecordIds?: string[];
}

/** Build diff, write prompt, copy tools, spawn, parse, check caps. */
export async function preApply(
  ctx: OrchestratorContext,
  args: RunBatchArgs,
  cap: NightConsolidationConfig | undefined,
  result: RunBatchResult,
): Promise<PreApplyResult> {
  const dbPath = path.join(ctx.dataDir, "vectors.db");
  const sliceTime = args.isNight ? maxL0RecordedAt(dbPath) : null;

  // Manifest baseline per chunk: a previous chunk may have rewritten
  // scene/persona files → a run-start baseline would 409 on chunk 2+.
  const baseline = buildManifestBaseline(ctx.dataDir);
  const diff = buildDiffSection({
    cursorIso: args.cp.l0Cursor,
    diffCap: cap?.diffCap ?? ctx.config.memory.consolidation.diffCap,
    diffByteCap: cap?.diffByteCap ?? ctx.config.memory.consolidation.diffByteCap,
    records: args.records,
    overLimitBlocks: args.overLimit,
    checkpointRunAt: args.cp.lastRunAt ?? undefined,
    idsOnly: args.isNight,
  });
  result.presented = diff.presentedRecordIds.length;
  result.sliceTime = sliceTime ?? null;
  result.diffText = diff.text;

  await fs.promises.mkdir(args.scratchDir, { recursive: true });
  const promptPath = path.join(args.scratchDir, "memory-keeper-prompt.md");
  await fs.promises.writeFile(
    promptPath,
    composeSessionPrompt(diff.text, args.role, ctx.roleDir, ctx.roleName),
    "utf-8",
  );
  await copyKeeperTools(ctx, args.scratchDir);

  if (args.dryRun) {
    result.status = "dry-run";
    return { ok: false };
  }

  const childResult: ChildRunResult = await ctx.spawnChild({
    runId: args.runId,
    scratchDir: args.scratchDir,
    promptPath,
    taskPrompt: DEFAULT_TASK_PROMPT,
    env: buildChildEnv({
      home: process.env.HOME ?? "/tmp",
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
      gatewayUrl: ctx.gatewayUrl,
      runUuid: args.runId,
    }),
    cwd: args.scratchDir,
    role: args.role,
  });
  result.child = {
    exitCode: childResult.exitCode,
    timedOut: childResult.timedOut,
    stdout: truncate(childResult.stdout, 2000),
    stderr: truncate(childResult.stderr, 4000),
  };

  if (childResult.error) {
    result.error = `keeper spawn failed: ${childResult.error}`;
    result.status = "failed";
    return { ok: false };
  }
  if (childResult.timedOut) {
    result.error = "keeper timed out — process group killed";
    result.status = "failed";
    return { ok: false };
  }

  const raw = await readScratchDiff(args.scratchDir);
  if (raw.error) {
    result.error = raw.error;
    result.status = "failed";
    return { ok: false };
  }

  if (cap && !checkCaps(raw.value, cap, args.remainingDeleteCap, args.remainingRewriteCap, result)) {
    return { ok: false };
  }

  return {
    ok: true,
    rawDiff: raw.value,
    baseline,
    presentedRecordIds: diff.presentedRecordIds,
  };
}

async function readScratchDiff(
  scratchDir: string,
): Promise<{ value: unknown; error?: undefined } | { value: null; error: string }> {
  try {
    const raw = await fs.promises.readFile(
      path.join(scratchDir, "diff.json"),
      "utf-8",
    );
    return { value: JSON.parse(raw) };
  } catch (err) {
    return {
      value: null,
      error: `diff.json missing or malformed in scratch (${path.join(scratchDir, "diff.json")}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
