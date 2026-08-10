/**
 * Misc helpers for the orchestrator: post-run P10 extras (probe → dashboard
 * → digest), default spawn/apply.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import { writeDashboard, writeDigest } from "../reports.js";
import { runRecallProbe } from "../probe.js";
import {
  ApplyExecutor,
  type ApplyResult,
  type RunContext,
} from "../apply-executor.js";
import type { ChildRunResult } from "./launchers/pi-process.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary, SpawnChildContext } from "./types.js";

/** P10 post-run extras (probe → dashboard → digest). Each step is
 * fail-open; this function itself never throws. */
export async function runPostRunSteps(
  ctx: OrchestratorContext,
  summary: RunSummary,
): Promise<void> {
  const probe = await runRecallProbe({
    dataDir: ctx.dataDir,
    cfg: ctx.config.memory,
    vectorStore: ctx.vectorStore?.(),
    embeddingService: ctx.embeddingService?.(),
    logger: ctx.logger,
  });
  summary.probe = probe;
  const vecs = {
    vectorStore: ctx.vectorStore?.(),
    embeddingService: ctx.embeddingService?.(),
  };
  await writeDashboard({
    dataDir: ctx.dataDir,
    logger: ctx.logger,
    ...vecs,
    probe,
  });
  writeDigest(
    ctx.dataDir,
    {
      runAt: summary.finishedAt,
      status: summary.status,
      mergedDuplicates:
        summary.applied.deletes.length + summary.applied.merges.length,
      rewrittenScenes: summary.applied.rewrites.length,
      precisionAtK: probe.precisionAtK,
      elapsedMs: summary.elapsedMs,
      newL0: summary.newL0,
      recordsPresented: summary.recordsPresented,
      error: summary.error,
    },
    ctx.logger,
  );
}

/** Default child spawner: goes through the RoleLauncher port (tz-06 Ф1), so
 * nothing here knows a binary name or a host flag. Model, thinking level,
 * timeout and assets still come from the RESOLVED CONTRACT (tz-01 B5). */
export async function defaultSpawnChild(
  ctx: OrchestratorContext,
  childCtx: SpawnChildContext,
): Promise<ChildRunResult> {
  const launcher = ctx.launcherFor(childCtx.contract.binding.launcherId);
  const outcome = await launcher.launch({
    runId: childCtx.runId,
    cwd: childCtx.cwd,
    promptPath: childCtx.promptPath,
    taskPrompt: childCtx.taskPrompt,
    env: childCtx.env,
    contract: childCtx.contract,
    onSpawn: (kill) => {
      ctx.childrenRef.value.set(childCtx.runId, { kill });
    },
  });

  if (!outcome.ok) {
    // A typed LaunchError is the host refusing, not the role failing — it
    // travels as a run error, never as a rejected promise (criterion 10).
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: `${outcome.error.kind}: ${outcome.error.message}`,
      killed: null,
    };
  }

  const res = await outcome.handle.completion;
  return {
    exitCode: res.exitCode,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.status === "timed_out",
    error: res.error,
    killed: null,
  };
}

/** Default applier: instantiate ApplyExecutor and call apply(body).
 *
 * tz-09 Ф3: the role-scoped policy travels as the SECOND argument, never in
 * the body — `applyRequestSchema` is a strict object, and a policy inside the
 * payload is a policy the payload's author can rewrite. */
export async function defaultApplyDiff(
  ctx: OrchestratorContext,
  body: unknown,
  run?: RunContext,
): Promise<ApplyResult> {
  const executor = new ApplyExecutor({
    dataDir: ctx.dataDir,
    logger: ctx.logger,
    vectorStore: ctx.vectorStore?.(),
    embeddingService: ctx.embeddingService?.(),
    runRepo: ctx.applyRunRepo,
  });
  return executor.apply(body, run);
}
