import fs from "node:fs/promises";
import path from "node:path";
import {
  digestL1Artifact,
  parseL1Candidate,
  parseL1CandidateProposal,
} from "../../core/record/l1-agent-codec.js";
import type { L1ConflictCandidateRepository } from "../../core/record/l1-conflict-candidates.js";
import type { L1WorksetV1 } from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import type { ResolvedRoleContract } from "../consolidation/role-contract-types.js";
import type { RoleLauncher, RunningHandle } from "../consolidation/launchers/types.js";
import { createL1AttemptArtifact } from "./l1-attempt-repo.js";
import { reviewL1Candidate, type L1ReviewOutcome } from "./l1-dispatch-review.js";
import { runL1StdoutRole } from "./l1-role-attempt.js";
import { parseStdoutJson } from "./l1-role-output.js";
import {
  assertLiveRoleLease,
  type RoleExecutionLease,
} from "../../agents/role-execution-lease.js";

export interface L1RetryFeedback {
  reasons: string[];
  conflicts: unknown[];
}

export async function executeL1Attempt(input: {
  dataDir: string;
  workset: L1WorksetV1;
  extractor: ResolvedRoleContract;
  critic: ResolvedRoleContract;
  runId: string;
  scratchDir: string;
  launcherFor: (id: string) => RoleLauncher;
  conflicts: L1ConflictCandidateRepository;
  logger: Logger;
  maxMemoriesPerSession: number;
  now: () => number;
  owner: string;
  fence: number;
  ordinal: number;
  retry: L1RetryFeedback | null;
  lease: RoleExecutionLease;
  onHandleStarted: (attemptId: string, handle: RunningHandle) => void;
  onHandleSettled: (attemptId: string) => void;
}): Promise<L1ReviewOutcome> {
  const launch = await runL1StdoutRole({
    ...input,
    kind: "launch",
    contract: input.extractor,
    launcher: input.launcherFor(input.extractor.binding.launcherId),
    taskPrompt: JSON.stringify({ workset: input.workset, retry: input.retry }),
  });
  if (!launch.ok) throw new Error(launch.error);
  assertLiveRoleLease(input.lease);
  const raw = parseStdoutJson(launch.stdout);
  const proposal = parseL1CandidateProposal(
    raw,
    input.workset,
    input.maxMemoriesPerSession,
  );
  const conflicts = await Promise.all(
    proposal.scenes.flatMap(({ memories }) =>
      memories.map((candidate) =>
        input.conflicts.recall(candidate, input.workset.projectId),
      ),
    ),
  );
  const allowedTargetIds = new Map(
    conflicts.map(({ candidateId, matches }) => [
      candidateId,
      new Set(matches.map(({ id }) => id)),
    ]),
  );
  const candidate = parseL1Candidate(
    raw,
    input.workset,
    allowedTargetIds,
    input.maxMemoriesPerSession,
  );
  assertLiveRoleLease(input.lease);
  const parentPolicyReasons = conflicts.flatMap((snapshot) => {
    if (!snapshot.nearDuplicateTargetId) return [];
    const memory = candidate.scenes
      .flatMap(({ memories }) => memories)
      .find(({ candidateId }) => candidateId === snapshot.candidateId);
    return memory?.action === "update" &&
      memory.targetIds.length === 1 &&
      memory.targetIds[0] === snapshot.nearDuplicateTargetId
      ? []
      : [`${snapshot.candidateId} must update near-duplicate ${snapshot.nearDuplicateTargetId}`];
  });
  const reviewInput = {
    workset: input.workset,
    candidate,
    conflicts,
    priorCriticReasons: input.retry?.reasons ?? [],
  };
  const candidateDigest = digestL1Artifact(candidate);
  const reviewInputDigest = digestL1Artifact(reviewInput);
  const nowIso = new Date(input.now()).toISOString();
  await fs.writeFile(
    path.join(input.scratchDir, "out", `result-${input.ordinal}.json`),
    JSON.stringify(candidate, null, 2),
  );
  createL1AttemptArtifact({
    dataDir: input.dataDir,
    nowIso,
    row: {
      attemptId: launch.attemptId,
      assignmentId: input.workset.assignmentId,
      runId: input.runId,
      fence: input.fence,
      ordinal: input.ordinal,
      worksetDigest: digestL1Artifact(input.workset),
      reviewInputJson: JSON.stringify(reviewInput),
      reviewInputDigest,
      candidateJson: JSON.stringify(candidate),
      candidateDigest,
    },
  });
  return reviewL1Candidate({
    ...input,
    assignmentId: input.workset.assignmentId,
    extractorAttemptId: launch.attemptId,
    nowIso,
    candidate,
    reviewInput,
    candidateDigest,
    reviewInputDigest,
    parentPolicyReasons,
  });
}
