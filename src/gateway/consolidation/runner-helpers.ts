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
import { finishAttempt } from "../control-plane/attempt-repo.js";
import { launchRoleAttempt } from "../../agents/role-execution-service.js";
import { taggedLogger, runTag } from "../../utils/logger-tag.js";
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
      leakageRate: probe.leakageRate,
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
  // Onto the ROW, not only into the log: `RoleRun.binding` persists the
  // thinking level, so a reader of the run would otherwise see a level the
  // host never applied and nothing saying so.
  const launched = await launchRoleAttempt({
    launcher,
    logger: ctx.logger,
    launch: {
      runId: childCtx.runId,
      attemptId: childCtx.attemptId,
      cwd: childCtx.cwd,
      promptPath: childCtx.promptPath,
      taskPrompt: childCtx.taskPrompt,
      env: childCtx.env,
      contract: childCtx.contract,
      onSpawn: (kill) => {
        ctx.childrenRef.value.set(childCtx.runId, { kill });
      },
    },
  });
  const { outcome, droppedBinding } = launched;

  if (!outcome.ok) {
    // A typed LaunchError is the host refusing, not the role failing — it
    // travels as a run error, never as a rejected promise (criterion 10), and
    // it lands on the preallocated Attempt so the refusal is auditable.
    finishAttempt(
      ctx.dataDir,
      childCtx.attemptId,
      outcome.error.kind,
      JSON.stringify({
        launcherId: launcher.id,
        message: outcome.error.message,
      }),
      new Date(ctx.now()).toISOString(),
    );
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

  // Shutdown must reach the launcher's own cancel path, not the raw kill:
  // only `cancelAndWait` produces the `cancelled` terminal status and waits
  // for the reap, so without this a shutdown lands on the row as `failed`.
  ctx.childrenRef.value.set(childCtx.runId, {
    kill: () => {
      void outcome.handle.cancelAndWait();
    },
    cancelAndWait: () => outcome.handle.cancelAndWait(),
  });

  // The attempt's session is what makes a run inspectable afterwards, so the
  // reference goes onto the Attempt row rather than only into a log line.
  finishAttempt(
    ctx.dataDir,
    childCtx.attemptId,
    "launched",
    JSON.stringify({
      sessionRef: outcome.handle.sessionRef,
      launcherId: launcher.id,
      droppedBinding,
    }),
    new Date(ctx.now()).toISOString(),
  );

  const res = await outcome.handle.completion;
  // A host that only fails once the process exists (ENOENT, EACCES) still
  // failed to LAUNCH — criterion 10 wants that kind on the row, not the
  // generic "failed" every bad role also gets.
  const kind = res.launchError?.kind;
  // Terminal outcome on the SAME row: "launched" is where it started, not
  // how it ended, and a row frozen at "launched" reads as a wedged attempt.
  finishAttempt(
    ctx.dataDir,
    childCtx.attemptId,
    kind ?? res.status,
    JSON.stringify({
      sessionRef: outcome.handle.sessionRef,
      launcherId: launcher.id,
      droppedBinding,
      exitCode: res.exitCode,
      // Criterion 8: the operator surface needs the FULL output, and the
      // in-memory tail is capped. Without the spool paths on the row the
      // artefacts exist but nothing points at them.
      stdoutFile: res.stdoutFile ?? null,
      stderrFile: res.stderrFile ?? null,
      stdoutBytes: res.stdoutBytes,
      stderrBytes: res.stderrBytes,
      ...(kind === undefined ? {} : { message: res.launchError!.message }),
    }),
    new Date(ctx.now()).toISOString(),
  );
  return {
    exitCode: res.exitCode,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.status === "timed_out",
    error: kind === undefined ? res.error : `${kind}: ${res.error}`,
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
    // `ctx.applyDiff` is bound to the orchestrator's ctx, so a run-scoped
    // copy of the context never reaches here — the tag comes from the run
    // the apply names instead.
    logger: run?.runId
      ? taggedLogger(ctx.logger, runTag(run.runId))
      : ctx.logger,
    vectorStore: ctx.vectorStore?.(),
    embeddingService: ctx.embeddingService?.(),
    runRepo: ctx.applyRunRepo,
  });
  return executor.apply(body, run);
}
