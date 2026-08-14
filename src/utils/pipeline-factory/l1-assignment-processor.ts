import type {
  L1CandidateV1,
  L1ExtractionDispatcher,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { L1ConflictSnapshot } from "../../core/record/l1-conflict-candidates.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { updateRun } from "../../gateway/control-plane/run-repo.js";
import {
  commitL1Assignment,
  markL1AssignmentCommitting,
  readL1Assignment,
} from "../../gateway/l1/l1-assignment-repo.js";
import type { L1AssignmentRow } from "../../gateway/l1/l1-control-types.js";
import { commitL1Candidate } from "../../services/l1/l1-candidate-commit.js";
import { withL1CommitLease } from "../../services/l1/l1-commit-lease.js";
import { recoverL1Assignment } from "../../gateway/l1/l1-recovery.js";
import { readL1AttemptArtifact } from "../../gateway/l1/l1-status-repo.js";
import type { PipelineLogger } from "./types.js";

export interface L1AssignmentProcessResult {
  ok: boolean; memoryCount: number; lastSceneName?: string;
}
export async function processL1Assignment(input: {
  dataDir: string;
  role: string;
  assignment: L1AssignmentRow;
  dispatcher: L1ExtractionDispatcher;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger: PipelineLogger;
}): Promise<L1AssignmentProcessResult> {
  const workset = JSON.parse(input.assignment.worksetJson) as L1WorksetV1;
  let row = recoverL1Assignment(input.dataDir, input.assignment);
  if (row.state === "created" || row.state === "failed") {
    const dispatched = await input.dispatcher.dispatchExtraction({
      role: input.role,
      workset,
    });
    if (!dispatched.ok) {
      input.logger.warn(
        `[l1] assignment ${row.assignmentId} failed: ${dispatched.message}`,
      );
      return { ok: false, memoryCount: 0 };
    }
    row = readRequired(input.dataDir, row.assignmentId);
  }
  if (row.state === "running") return { ok: false, memoryCount: 0 };
  const committed = await commitReviewedAssignment(input, row, workset);
  if (!committed.ok) return { ok: false, memoryCount: 0 };
  const { candidate } = committed;
  return {
    ok: true,
    memoryCount: candidate.scenes
      .flatMap(({ memories }) => memories)
      .filter(({ action }) => action !== "skip").length,
    lastSceneName: candidate.scenes.at(-1)?.name,
  };
}

async function commitReviewedAssignment(
  input: Parameters<typeof processL1Assignment>[0],
  initial: L1AssignmentRow,
  workset: L1WorksetV1,
): Promise<{ ok: true; candidate: L1CandidateV1 } | { ok: false }> {
  const leased = await withL1CommitLease({
    dataDir: input.dataDir,
    logger: input.logger,
    commit: async (assertOwned) => {
      assertOwned();
      let row = readRequired(input.dataDir, initial.assignmentId);
      const candidate = JSON.parse(row.candidateJson ?? "null") as L1CandidateV1;
      const runId = row.runId;
      if (!candidate || !runId) return null;
      const targetSnapshots = readTargetSnapshots(input.dataDir, row);
      const nowIso = new Date().toISOString();
      if (row.state === "reviewed") {
        assertOwned();
        if (
          !markL1AssignmentCommitting({
            dataDir: input.dataDir,
            assignmentId: row.assignmentId,
            runId,
            nowIso,
          })
        )
          return null;
        assertOwned();
        updateRun(input.dataDir, runId, { state: "applying" }, nowIso);
        row = readRequired(input.dataDir, row.assignmentId);
      }
      if (row.state === "committing") {
        await commitL1Candidate({
          baseDir: input.dataDir,
          workset,
          candidate,
          vectorStore: input.vectorStore,
          embeddingService: input.embeddingService,
          logger: input.logger,
          journal: { runId, candidateDigest: row.candidateDigest! },
          targetSnapshots,
          assertLease: assertOwned,
        });
        assertOwned();
        if (
          !commitL1Assignment({
            dataDir: input.dataDir,
            assignmentId: row.assignmentId,
            runId,
            nowIso,
          })
        )
          return null;
        assertOwned();
        updateRun(input.dataDir, runId, { state: "applied", finishedAt: nowIso }, nowIso);
      } else if (row.state !== "committed") return null;
      return candidate;
    },
  });
  return leased.ok && leased.value
    ? { ok: true, candidate: leased.value }
    : { ok: false };
}

function readTargetSnapshots(
  dataDir: string,
  row: L1AssignmentRow,
): L1ConflictSnapshot[] {
  if (!row.approvedAttemptId)
    throw new Error(`assignment ${row.assignmentId} has no approved attempt`);
  const artifact = readL1AttemptArtifact(dataDir, row.approvedAttemptId);
  if (!artifact)
    throw new Error(`approved artifact ${row.approvedAttemptId} disappeared`);
  const review = JSON.parse(artifact.reviewInputJson) as {
    conflicts?: unknown;
  };
  if (!Array.isArray(review.conflicts))
    throw new Error(`artifact ${row.approvedAttemptId} has no conflicts`);
  return review.conflicts as L1ConflictSnapshot[];
}

function readRequired(dataDir: string, assignmentId: string): L1AssignmentRow {
  const row = readL1Assignment(dataDir, assignmentId);
  if (!row) throw new Error(`L1 assignment ${assignmentId} disappeared`);
  return row;
}
