import fs from "node:fs/promises";
import path from "node:path";
import {
  digestL1Artifact,
  parseL1Candidate,
  parseL1CandidateProposal,
} from "../../core/record/l1-agent-codec.js";
import type {
  L1ConflictCandidateRepository,
  L1ConflictSnapshot,
} from "../../core/record/l1-conflict-candidates.js";
import type {
  L1CandidateV1,
  L1DispatchResult,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import type { ResolvedRoleContract } from "../consolidation/role-contract-types.js";
import type {
  RoleLauncher,
  RunningHandle,
} from "../consolidation/launchers/types.js";
import { approveL1Candidate } from "./l1-dispatch-approve.js";
import { createL1AttemptArtifact, settleL1Attempt } from "./l1-attempt-repo.js";
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

export type L1AttemptOutcome =
  | { approved: true; result: Extract<L1DispatchResult, { ok: true }> }
  | { approved: false; reasons: string[]; conflicts: unknown[] };

export async function executeL1Attempt(input: {
  dataDir: string;
  workset: L1WorksetV1;
  extractor: ResolvedRoleContract;
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
}): Promise<L1AttemptOutcome> {
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
  const conflicts = await recallConflicts(raw, input);
  const candidate = parseL1Candidate(
    raw,
    input.workset,
    allowedTargetIds(conflicts),
    input.maxMemoriesPerSession,
  );
  assertLiveRoleLease(input.lease);
  const policyReasons = nearDuplicateViolations(conflicts, candidate);
  const candidateDigest = digestL1Artifact(candidate);
  const nowIso = new Date(input.now()).toISOString();
  await recordCandidate({
    ...input,
    candidate,
    candidateDigest,
    conflicts,
    nowIso,
    attemptId: launch.attemptId,
  });
  return settleAttempt({
    ...input,
    attemptId: launch.attemptId,
    candidate,
    candidateDigest,
    conflicts,
    policyReasons,
    nowIso,
  });
}

/** Close the attempt on the gateway's own verdict: a policy breach is recorded
 * and handed back as retry feedback, a clean candidate is promoted. */
function settleAttempt(input: {
  dataDir: string;
  runId: string;
  workset: L1WorksetV1;
  owner: string;
  fence: number;
  attemptId: string;
  candidate: L1CandidateV1;
  candidateDigest: string;
  conflicts: L1ConflictSnapshot[];
  policyReasons: string[];
  nowIso: string;
}): L1AttemptOutcome {
  if (input.policyReasons.length > 0) {
    settleL1Attempt({
      dataDir: input.dataDir,
      attemptId: input.attemptId,
      approved: false,
      nowIso: input.nowIso,
    });
    return {
      approved: false,
      reasons: input.policyReasons,
      conflicts: input.conflicts,
    };
  }
  return {
    approved: true,
    result: approveL1Candidate({
      ...input,
      assignmentId: input.workset.assignmentId,
    }),
  };
}

/** Recall the store's own near-duplicate view for every proposed memory. The
 * proposal is parsed WITHOUT target validation first: the allowed targets are
 * exactly what this recall returns. */
async function recallConflicts(
  raw: unknown,
  input: {
    workset: L1WorksetV1;
    conflicts: L1ConflictCandidateRepository;
    maxMemoriesPerSession: number;
  },
): Promise<L1ConflictSnapshot[]> {
  const proposal = parseL1CandidateProposal(
    raw,
    input.workset,
    input.maxMemoriesPerSession,
  );
  return await Promise.all(
    proposal.scenes.flatMap(({ memories }) =>
      memories.map((candidate) =>
        input.conflicts.recall(candidate, input.workset.projectId),
      ),
    ),
  );
}

function allowedTargetIds(
  conflicts: L1ConflictSnapshot[],
): Map<string, Set<string>> {
  return new Map(
    conflicts.map(({ candidateId, matches }) => [
      candidateId,
      new Set(matches.map(({ id }) => id)),
    ]),
  );
}

/** The one store rule the gateway owns: a memory the store already holds must
 * be updated, not stored again. Everything else about the candidate's quality
 * is the pi role's critic to judge. */
function nearDuplicateViolations(
  conflicts: L1ConflictSnapshot[],
  candidate: L1CandidateV1,
): string[] {
  return conflicts.flatMap((snapshot) => {
    if (!snapshot.nearDuplicateTargetId) return [];
    const memory = candidate.scenes
      .flatMap(({ memories }) => memories)
      .find(({ candidateId }) => candidateId === snapshot.candidateId);
    return memory?.action === "update" &&
      memory.targetIds.length === 1 &&
      memory.targetIds[0] === snapshot.nearDuplicateTargetId
      ? []
      : [
          `${snapshot.candidateId} must update near-duplicate ${snapshot.nearDuplicateTargetId}`,
        ];
  });
}

/** Durable record of what this attempt produced and what the store looked like
 * when it was checked — written BEFORE the outcome so a crash between the two
 * leaves a replayable candidate, never a silent loss. */
async function recordCandidate(input: {
  dataDir: string;
  scratchDir: string;
  runId: string;
  workset: L1WorksetV1;
  fence: number;
  ordinal: number;
  attemptId: string;
  candidate: L1CandidateV1;
  candidateDigest: string;
  conflicts: L1ConflictSnapshot[];
  retry: L1RetryFeedback | null;
  nowIso: string;
}): Promise<void> {
  const reviewInput = {
    workset: input.workset,
    candidate: input.candidate,
    conflicts: input.conflicts,
    priorReasons: input.retry?.reasons ?? [],
  };
  await fs.writeFile(
    path.join(input.scratchDir, "out", `result-${input.ordinal}.json`),
    JSON.stringify(input.candidate, null, 2),
  );
  createL1AttemptArtifact({
    dataDir: input.dataDir,
    nowIso: input.nowIso,
    row: {
      attemptId: input.attemptId,
      assignmentId: input.workset.assignmentId,
      runId: input.runId,
      fence: input.fence,
      ordinal: input.ordinal,
      worksetDigest: digestL1Artifact(input.workset),
      reviewInputJson: JSON.stringify(reviewInput),
      reviewInputDigest: digestL1Artifact(reviewInput),
      candidateJson: JSON.stringify(input.candidate),
      candidateDigest: input.candidateDigest,
    },
  });
}
