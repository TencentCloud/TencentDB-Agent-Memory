/**
 * Misc helpers for the orchestrator: post-run P10 extras (probe → dashboard
 * → digest), default spawn/apply.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import { writeDashboard, writeDigest } from "../reports.js";
import { runRecallProbe } from "../probe.js";
import type { ChildProcess } from "node:child_process";
import { runKeeperProcess } from "./keeper-run.js";
import { killChildGroup } from "./child-spawn.js";
import { ApplyExecutor, type ApplyResult } from "../apply-executor.js";
import { resolveRoleTimeoutMs } from "./types.js";
import { buildRoleSpawnArgs } from "./role-spawn-args.js";
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

/** Default child spawner: builds the child env, picks the per-run timeout
 * from the role file, and registers the kill handle on `ctx.childrenRef`. */
export async function defaultSpawnChild(
  ctx: OrchestratorContext,
  childCtx: SpawnChildContext,
): ReturnType<typeof runKeeperProcess> {
  const timeoutMs = resolveRoleTimeoutMs(
    childCtx.role,
    ctx.roleDir,
    ctx.config.memory.consolidation.timeoutMs,
  );
  // Forked task-cycle wiring (path б): role.json runtime.extension_path /
  // skill_path → --extension / --skill CLI args. Legacy roles: no extra args.
  const extraArgs = buildRoleSpawnArgs(childCtx, ctx.roleDir);
  return runKeeperProcess({
    piBinary: ctx.config.memory.consolidation.piBinary,
    spawnFlags: ctx.config.memory.consolidation.spawnFlags,
    extraArgs,
    model: ctx.config.memory.consolidation.model,
    thinking: ctx.config.memory.consolidation.thinking,
    systemPromptPath: childCtx.promptPath,
    taskPrompt: childCtx.taskPrompt,
    cwd: childCtx.cwd,
    env: childCtx.env,
    timeoutMs,
    logger: ctx.logger,
    onChild: (child: ChildProcess) => {
      ctx.childrenRef.value.set(childCtx.runId, {
        kill: () => killChildGroup(child, ctx.logger),
      });
    },
  });
}

/** Default applier: instantiate ApplyExecutor and call apply(body). */
export async function defaultApplyDiff(
  ctx: OrchestratorContext,
  body: unknown,
): Promise<ApplyResult> {
  const executor = new ApplyExecutor({
    dataDir: ctx.dataDir,
    logger: ctx.logger,
    vectorStore: ctx.vectorStore?.(),
    embeddingService: ctx.embeddingService?.(),
  });
  return executor.apply(body);
}
