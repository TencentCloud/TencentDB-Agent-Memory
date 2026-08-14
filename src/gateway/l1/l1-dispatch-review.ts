import fs from "node:fs/promises";
import path from "node:path";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import { L1DispatchError } from "../../core/record/l1-agent-errors.js";
import type {
  L1CandidateV1,
  L1DispatchResult,
} from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import { updateRun } from "../control-plane/run-repo.js";
import type { ResolvedRoleContract } from "../consolidation/role-contract-types.js";
import type { RoleLauncher, RunningHandle } from "../consolidation/launchers/types.js";
import {
  approveL1Assignment,
  recordL1CriticVerdict,
} from "./l1-attempt-repo.js";
import { runL1StdoutRole } from "./l1-role-attempt.js";
import { parseL1CriticVerdict } from "./l1-role-output.js";
import {
  assertLiveRoleLease,
  type RoleExecutionLease,
} from "../../agents/role-execution-lease.js";

export type L1ReviewOutcome =
  | { approved: true; result: Extract<L1DispatchResult, { ok: true }> }
  | { approved: false; reasons: string[]; conflicts: unknown[] };

export async function reviewL1Candidate(input: {
  dataDir: string;
  runId: string;
  scratchDir: string;
  critic: ResolvedRoleContract;
  launcherFor: (id: string) => RoleLauncher;
  logger: Logger;
  now: () => number;
  assignmentId: string;
  extractorAttemptId: string;
  owner: string;
  fence: number;
  nowIso: string;
  candidate: L1CandidateV1;
  reviewInput: unknown;
  candidateDigest: string;
  reviewInputDigest: string;
  parentPolicyReasons: string[];
  lease: RoleExecutionLease;
  onHandleStarted: (attemptId: string, handle: RunningHandle) => void;
  onHandleSettled: (attemptId: string) => void;
}): Promise<L1ReviewOutcome> {
  assertLiveRoleLease(input.lease);
  const review = await runL1StdoutRole({
    dataDir: input.dataDir,
    runId: input.runId,
    scratchDir: input.scratchDir,
    kind: "critic",
    contract: input.critic,
    launcher: input.launcherFor(input.critic.binding.launcherId),
    taskPrompt: JSON.stringify({
      reviewInput: input.reviewInput,
      candidateDigest: input.candidateDigest,
      inputDigest: input.reviewInputDigest,
    }),
    logger: input.logger,
    now: input.now,
    onHandleStarted: input.onHandleStarted,
    onHandleSettled: input.onHandleSettled,
  });
  if (!review.ok) throw new Error(review.error);
  assertLiveRoleLease(input.lease);
  const verdict = parseL1CriticVerdict(review.stdout);
  if (
    verdict.candidateDigest !== input.candidateDigest ||
    verdict.inputDigest !== input.reviewInputDigest
  )
    throw new L1DispatchError(
      "critic-rejected",
      "critic receipt digest mismatch",
    );
  await fs.writeFile(
    path.join(input.scratchDir, "out", "critic.json"),
    JSON.stringify(verdict, null, 2),
  );
  const isApproved =
    verdict.verdict === "approve" && input.parentPolicyReasons.length === 0;
  recordL1CriticVerdict({
    dataDir: input.dataDir,
    attemptId: input.extractorAttemptId,
    criticAttemptId: review.attemptId,
    verdict,
    isApproved,
    nowIso: input.nowIso,
  });
  if (!isApproved)
    return {
      approved: false,
      reasons: [...verdict.reasons, ...input.parentPolicyReasons],
      conflicts: (input.reviewInput as { conflicts?: unknown[] }).conflicts ?? [],
    };
  if (
    !approveL1Assignment({
      dataDir: input.dataDir,
      assignmentId: input.assignmentId,
      runId: input.runId,
      attemptId: input.extractorAttemptId,
      nowIso: input.nowIso,
    })
  )
    throw new Error("approval receipt was not persisted");
  const receipt = digestL1Artifact(verdict);
  updateRun(
    input.dataDir,
    input.runId,
    {
      state: "reviewed",
      candidateDigest: input.candidateDigest,
      verdictDigest: receipt,
      criticReceipt: JSON.stringify(verdict),
    },
    input.nowIso,
    { owner: input.owner, fence: input.fence },
  );
  return {
    approved: true,
    result: {
      ok: true,
      runId: input.runId,
      approvedAttemptId: input.extractorAttemptId,
      candidate: input.candidate,
      criticReceipt: receipt,
    },
  };
}
