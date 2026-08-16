/**
 * Promotion of a validated L1 candidate into an approved assignment.
 *
 * "Approved" here is the GATEWAY's own statement: the candidate parsed against
 * the schema and satisfied the store rules the parent owns (near-duplicate
 * policy). Judging how well the memories are worded belongs to the critic
 * INSIDE the pi role — see AGENTS.md; the gateway neither launches it nor reads
 * its verdict.
 */
import { L1AgentPersistenceError } from "../../core/record/l1-agent-errors.js";
import type {
  L1CandidateV1,
  L1DispatchResult,
} from "../../core/record/l1-agent-types.js";
import { updateRun } from "../control-plane/run-repo.js";
import { approveL1Assignment, settleL1Attempt } from "./l1-attempt-repo.js";

export function approveL1Candidate(input: {
  dataDir: string;
  runId: string;
  assignmentId: string;
  attemptId: string;
  owner: string;
  fence: number;
  nowIso: string;
  candidate: L1CandidateV1;
  candidateDigest: string;
}): Extract<L1DispatchResult, { ok: true }> {
  if (
    !settleL1Attempt({
      dataDir: input.dataDir,
      attemptId: input.attemptId,
      approved: true,
      nowIso: input.nowIso,
    })
  )
    throw new L1AgentPersistenceError(
      `attempt "${input.attemptId}" was not in the candidate state`,
    );
  if (
    !approveL1Assignment({
      dataDir: input.dataDir,
      assignmentId: input.assignmentId,
      runId: input.runId,
      attemptId: input.attemptId,
      candidateDigest: input.candidateDigest,
      nowIso: input.nowIso,
    })
  )
    throw new L1AgentPersistenceError("approval receipt was not persisted");
  updateRun(
    input.dataDir,
    input.runId,
    { state: "reviewed", candidateDigest: input.candidateDigest },
    input.nowIso,
    { owner: input.owner, fence: input.fence },
  );
  return {
    ok: true,
    runId: input.runId,
    approvedAttemptId: input.attemptId,
    candidate: input.candidate,
  };
}
