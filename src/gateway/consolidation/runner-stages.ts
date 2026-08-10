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
import {
  DEFAULT_TASK_PROMPT,
  buildSessionPrompt as composeSessionPrompt,
} from "./prompt-builder.js";
import { copyKeeperTools } from "./keeper-tools.js";
import { truncate } from "./chunk.js";
import { checkCaps } from "./check-caps.js";
import { readScratchDiff } from "./scratch-diff.js";
import { rejectStaleArtifact } from "./artifact-fence.js";
import type { OrchestratorContext } from "./context.js";
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
  result: RunBatchResult,
): Promise<PreApplyResult> {
  const contract = args.contract;
  const chunked = contract.batching.strategy === "bounded-full-store-chunked";
  const dbPath = path.join(ctx.dataDir, "vectors.db");
  ctx.logger.debug?.(
    `[stages] preApply start role=${args.role} ` +
      `records=${args.records?.length ?? 0} strategy=${contract.batching.strategy}`,
  );
  const sliceTime = chunked ? maxL0RecordedAt(dbPath) : null;

  // Manifest baseline per chunk: a previous chunk may have rewritten
  // scene/persona files → a run-start baseline would 409 on chunk 2+.
  const baseline = buildManifestBaseline(ctx.dataDir);
  const diff = buildDiffSection({
    cursorIso: args.cp.l0Cursor,
    diffCap: contract.batching.diffCap,
    diffByteCap: contract.batching.diffByteCap,
    records: args.records,
    overLimitBlocks: args.overLimit,
    checkpointRunAt: args.cp.lastRunAt ?? undefined,
    idsOnly: contract.batching.idsOnly,
  });
  result.presented = diff.presentedRecordIds.length;
  result.sliceTime = sliceTime ?? null;
  result.diffText = diff.text;

  await fs.promises.mkdir(args.scratchDir, { recursive: true });
  const promptPath = path.join(args.scratchDir, "memory-keeper-prompt.md");
  await fs.promises.writeFile(
    promptPath,
    composeSessionPrompt(diff.text, contract),
    "utf-8",
  );
  // The presented diff on disk (forked task-cycle path б), for a role or
  // critic that wants the input as a file rather than as prompt text.
  //
  // NOT `diff.json`: that is the file the role is contractually required to
  // WRITE. Sharing one path made the input indistinguishable from the output —
  // a role that produced nothing left our own markdown behind, and the reader
  // parsed it and reported "malformed JSON" instead of "no candidate". The
  // live instance logged 335 such lines into .metadata/diff-malformed.log.
  await fs.promises.writeFile(
    path.join(args.scratchDir, "presented-diff.md"),
    diff.text,
    "utf-8",
  );
  await copyKeeperTools(ctx, args.scratchDir, contract.toolsSubset);

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
      ownerPid: ctx.ownerPid,
    }),
    cwd: args.scratchDir,
    role: args.role,
    contract,
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

  // tz-09 Ф2: the candidate is INGESTED here, so this is where the fence is
  // worth something. A child of an attempt that was taken over (or a run that
  // was cancelled) still writes its diff.json — the reader refuses it.
  const fenceError = rejectStaleArtifact(ctx, args.runId, args.scratchDir);
  if (fenceError !== null) {
    result.error = fenceError;
    result.status = "failed";
    return { ok: false };
  }

  if (
    chunked &&
    !checkCaps(
      raw.value,
      args.remainingDeleteCap,
      args.remainingRewriteCap,
      result,
    )
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    rawDiff: raw.value,
    baseline,
    presentedRecordIds: diff.presentedRecordIds,
  };
}
