/**
 * Misc helpers for the orchestrator: keeper-tools resolution + copy,
 * post-run P10 extras (probe → dashboard → digest), default spawn/apply.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDashboard, writeDigest } from "../reports.js";
import { runRecallProbe } from "../probe.js";
import { runKeeperProcess, killChildGroup, type ChildProcess } from "./child-spawn.js";
import { ApplyExecutor, type ApplyResult } from "../apply-executor.js";
import { resolveRoleTimeoutMs } from "./types.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary, SpawnChildContext } from "./types.js";

/**
 * Resolve the keeper-tools dir. The gateway always runs from the source
 * tree (`bun src/gateway/server.ts` / `npx tsx src/gateway/server.ts`) —
 * dist/ never bundles the orchestrator. Env override wins when set.
 */
export function resolveKeeperToolsDir(): string | null {
  const envOverride = process.env.TDAI_KEEPER_TOOLS_DIR;
  if (envOverride) {
    return fs.existsSync(path.join(envOverride, "fetch_dups.py"))
      ? envOverride
      : null;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "keeper-tools"),
      path.join(here, "..", "consolidation", "keeper-tools"),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(path.join(cand, "fetch_dups.py"))) return cand;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Copy the static keeper-tools into `<runScratch>/tools/`. FAIL-OPEN: any
 * error (missing dir, fs failure) → warn + continue, never aborts the run.
 */
export async function copyKeeperTools(
  ctx: OrchestratorContext,
  runScratch: string,
): Promise<string | null> {
  const src = resolveKeeperToolsDir();
  if (!src) {
    ctx.logger.warn?.(
      "[memory-keeper] keeper-tools dir not found — sub-session will generate its own scripts",
    );
    return null;
  }
  const dst = path.join(runScratch, "tools");
  try {
    await fs.promises.cp(src, dst, { recursive: true });
    return dst;
  } catch (err) {
    ctx.logger.warn?.(
      `[memory-keeper] copy keeper-tools failed (${err instanceof Error ? err.message : String(err)}) — continuing without tools`,
    );
    return null;
  }
}

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
  const vecs = { vectorStore: ctx.vectorStore?.(), embeddingService: ctx.embeddingService?.() };
  await writeDashboard({ dataDir: ctx.dataDir, logger: ctx.logger, ...vecs, probe });
  writeDigest(ctx.dataDir, {
    runAt: summary.finishedAt,
    status: summary.status,
    mergedDuplicates: summary.applied.deletes.length + summary.applied.merges.length,
    rewrittenScenes: summary.applied.rewrites.length,
    precisionAtK: probe.precisionAtK,
    elapsedMs: summary.elapsedMs,
    newL0: summary.newL0,
    recordsPresented: summary.recordsPresented,
    error: summary.error,
  }, ctx.logger);
}

/** Default child spawner: builds the child env, picks the per-run timeout
 * from the role file, and registers the kill handle on `ctx.currentChildRef`. */
export async function defaultSpawnChild(
  ctx: OrchestratorContext,
  childCtx: SpawnChildContext,
): ReturnType<typeof runKeeperProcess> {
  const timeoutMs = resolveRoleTimeoutMs(
    childCtx.role,
    ctx.roleDir,
    ctx.config.memory.consolidation.timeoutMs,
  );
  return runKeeperProcess({
    piBinary: ctx.config.memory.consolidation.piBinary,
    spawnFlags: ctx.config.memory.consolidation.spawnFlags,
    model: ctx.config.memory.consolidation.model,
    thinking: ctx.config.memory.consolidation.thinking,
    systemPromptPath: childCtx.promptPath,
    taskPrompt: childCtx.taskPrompt,
    cwd: childCtx.cwd,
    env: childCtx.env,
    timeoutMs,
    logger: ctx.logger,
    onChild: (child: ChildProcess) => {
      ctx.currentChildRef.value = {
        kill: () => killChildGroup(child, ctx.logger),
      };
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
