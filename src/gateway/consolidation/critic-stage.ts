/**
 * Critic stage (tz-09 Ф4b) — the gate between a candidate and apply.
 *
 * Fail-closed by construction: no verdict, an unparseable verdict, a verdict
 * about a DIFFERENT candidate, or a rejecting verdict all stop the apply.
 * The one thing it is not allowed to do is pass silently — that is why the
 * absence of a verdict is a refusal and not a default-approve.
 *
 * `shadow` (the default) logs what it WOULD have refused and lets the run
 * continue, so the stage can ship before any critic package exists.
 */
import { createHash } from "node:crypto";
import { resolveCriticPackage } from "./critic-bootstrap.js";
import { launchCritic } from "./critic-launch.js";
import { rejectStaleArtifact } from "./artifact-fence.js";
import { updateRun } from "../control-plane/run-repo.js";
import { runOwnerId } from "../control-plane/owner.js";
import type { OrchestratorContext } from "./context.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";

export interface CriticStageArgs {
  runId: string;
  scratchDir: string;
  role: ResolvedRoleContract;
  /** The candidate as parsed from <scratch>/diff.json. */
  candidate: unknown;
  /** Digest of the input the candidate was produced from. */
  inputDigest: string;
}

export interface CriticStageResult {
  /** False → apply must NOT run. */
  ok: boolean;
  reason?: string;
  candidateDigest: string;
}

export function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

interface Verdict {
  verdict?: unknown;
  candidateDigest?: unknown;
  inputDigest?: unknown;
  reasons?: unknown;
}

export async function runCriticStage(
  ctx: OrchestratorContext,
  args: CriticStageArgs,
): Promise<CriticStageResult> {
  const candidateDigest = digestOf(args.candidate);
  const enforce = ctx.applyGateMode === "enforce";
  const refuse = (reason: string): CriticStageResult => {
    if (enforce) return { ok: false, reason, candidateDigest };
    ctx.logger.warn?.(
      `[critic] SHADOW would refuse apply for ${args.role.role}/${args.runId}: ${reason}`,
    );
    return { ok: true, reason, candidateDigest };
  };

  const bootstrap = resolveCriticPackage(ctx, args.role);
  if (!bootstrap.ok) return refuse(bootstrap.reason);

  const launched = await launchCritic(ctx, {
    runId: args.runId,
    scratchDir: args.scratchDir,
    critic: bootstrap.contract,
    candidateDigest,
  });
  if (!launched.ok)
    return refuse(launched.error ?? "critic produced no verdict");

  // The verdict is an artefact too: a critic of a taken-over attempt must not
  // decide anything about the run it lost.
  const stale = rejectStaleArtifact(ctx, args.runId, args.scratchDir);
  if (stale !== null) return refuse(`verdict rejected: ${stale}`);

  let verdict: Verdict;
  try {
    verdict = JSON.parse(launched.verdictText ?? "") as Verdict;
  } catch (err) {
    return refuse(
      `verdict is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (verdict.verdict !== "approve" && verdict.verdict !== "reject") {
    return refuse(`verdict field is ${JSON.stringify(verdict.verdict)}`);
  }
  if (verdict.candidateDigest !== candidateDigest) {
    return refuse(
      `verdict is about a different candidate ` +
        `(verdict ${String(verdict.candidateDigest).slice(0, 12)}…, ` +
        `candidate ${candidateDigest.slice(0, 12)}…)`,
    );
  }
  if (
    verdict.inputDigest !== undefined &&
    verdict.inputDigest !== args.inputDigest
  ) {
    return refuse("verdict was produced from a different input");
  }

  const approved = verdict.verdict === "approve";
  // `reviewed` is what apply reads as "a critic approved THIS candidate"
  // (run-policy.ts), so a rejecting verdict must not write that state — only
  // its receipt.
  const receipt = writeReceipt(
    ctx,
    args,
    candidateDigest,
    launched.verdictText ?? "",
    approved,
  );
  if (!approved) {
    const reasons = Array.isArray(verdict.reasons)
      ? verdict.reasons.join("; ")
      : "no reasons given";
    return refuse(`critic rejected the candidate: ${reasons}`);
  }
  // A receipt we could not write is a receipt apply cannot read: losing the
  // run between the verdict and the record must stop the apply, not race it.
  if (!receipt) return refuse("critic receipt could not be recorded");
  return { ok: true, candidateDigest };
}

/** The receipt ties the verdict to the exact candidate it judged.
 * @returns false when the write did not land — see the caller. */
function writeReceipt(
  ctx: OrchestratorContext,
  args: CriticStageArgs,
  candidateDigest: string,
  verdictText: string,
  approved: boolean,
): boolean {
  try {
    const ok = updateRun(
      ctx.dataDir,
      args.runId,
      {
        state: approved ? "reviewed" : undefined,
        candidateDigest,
        verdictDigest: digestOf(verdictText),
        criticReceipt: verdictText.slice(0, 2000),
      },
      new Date(ctx.now()).toISOString(),
      { owner: runOwnerId(ctx.ownerPid) },
    );
    if (!ok) {
      ctx.logger.warn?.(
        `[critic] receipt refused for ${args.runId}: run no longer owned here`,
      );
    }
    return ok;
  } catch (err) {
    ctx.logger.warn?.(
      `[critic] receipt write failed for ${args.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
