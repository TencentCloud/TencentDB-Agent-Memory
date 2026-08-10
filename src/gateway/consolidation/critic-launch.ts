/**
 * Critic launch (tz-09 Ф4a) — the PRODUCER of the verdict.
 *
 * Before this, nothing in the pipeline ever wrote a verdict, so a fail-closed
 * critic gate would have disabled every run. The critic is spawned like any
 * other role, into the SAME scratch dir as the candidate it reviews, and is
 * expected to leave `<scratch>/critic.json`.
 *
 * The attempt is recorded as a CriticAttempt on the Run, so a bad verdict can
 * be retried over the same candidate (P9) instead of regenerating it.
 */
import fs from "node:fs";
import path from "node:path";
import { buildChildEnv } from "./child-spawn.js";
import { finishAttempt, recordAttempt } from "../control-plane/attempt-repo.js";
import type { OrchestratorContext } from "./context.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";

export const CRITIC_VERDICT_FILE = "critic.json";

export interface CriticLaunchArgs {
  runId: string;
  scratchDir: string;
  /** Contract of the CRITIC (already bootstrapped), not of the main role. */
  critic: ResolvedRoleContract;
  candidateDigest: string;
}

export interface CriticLaunchResult {
  ok: boolean;
  /** Raw verdict text, when the critic produced one. */
  verdictText?: string;
  error?: string;
}

const TASK_PROMPT =
  "Review the candidate diff in ./diff.json against the presented input. " +
  `Write your verdict as JSON to ./${CRITIC_VERDICT_FILE} with the fields ` +
  "{verdict: 'approve'|'reject', candidateDigest, reasons: string[]}.";

export async function launchCritic(
  ctx: OrchestratorContext,
  args: CriticLaunchArgs,
): Promise<CriticLaunchResult> {
  const startedAt = new Date(ctx.now()).toISOString();
  const attemptId = recordAttempt(ctx.dataDir, args.runId, "critic", startedAt);
  const verdictPath = path.join(args.scratchDir, CRITIC_VERDICT_FILE);
  // A verdict left by a previous attempt must never be mistaken for this
  // one's — the whole point of the gate is that SOME critic ran now.
  await fs.promises.rm(verdictPath, { force: true });

  const promptPath = path.join(args.scratchDir, "critic-prompt.md");
  await fs.promises.writeFile(
    promptPath,
    args.critic.prompt.text ?? "",
    "utf-8",
  );

  const finish = (outcome: string, detail: string | null): void => {
    finishAttempt(
      ctx.dataDir,
      attemptId,
      outcome,
      detail,
      new Date(ctx.now()).toISOString(),
    );
  };

  const child = await ctx.spawnChild({
    runId: args.runId,
    scratchDir: args.scratchDir,
    promptPath,
    taskPrompt: TASK_PROMPT,
    env: buildChildEnv({
      home: process.env.HOME ?? "/tmp",
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
      gatewayUrl: ctx.gatewayUrl,
      runUuid: args.runId,
      ownerPid: ctx.ownerPid,
    }),
    cwd: args.scratchDir,
    role: args.critic.role,
    contract: args.critic,
  });

  if (child.error) {
    finish("code", child.error);
    return { ok: false, error: `critic spawn failed: ${child.error}` };
  }
  if (child.timedOut) {
    finish("timeout", null);
    return { ok: false, error: "critic timed out — process group killed" };
  }

  let verdictText: string;
  try {
    verdictText = await fs.promises.readFile(verdictPath, "utf-8");
  } catch {
    finish("code", "no verdict file");
    return {
      ok: false,
      error: `critic produced no ${CRITIC_VERDICT_FILE} in ${args.scratchDir}`,
    };
  }
  finish("code", null);
  return { ok: true, verdictText };
}
