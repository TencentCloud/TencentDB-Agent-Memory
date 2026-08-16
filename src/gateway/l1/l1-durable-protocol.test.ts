import { afterEach, describe, expect, it } from "vitest";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import {
  commitL1Assignment,
  markL1AssignmentCommitting,
  readL1Assignment,
  startL1AssignmentEpoch,
} from "./l1-assignment-repo.js";
import {
  approveL1Assignment,
  createL1AttemptArtifact,
  settleL1Attempt,
} from "./l1-attempt-repo.js";
import {
  commitL1Cohort,
  createL1Cohort,
  listL1CohortAssignments,
  readOldestOpenL1Cohort,
} from "./l1-cohort-repo.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  createL1TestWorkset,
  L1_TEST_NOW,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("durable L1 protocol", () => {
  it("preserves manifest order independently of assignment ids", () => {
    const root = createL1TestDataDir(roots);
    const laterHash = createL1TestWorkset("l1a_z");
    const earlierHash = createL1TestWorkset("l1a_a");
    createL1Cohort(
      root,
      {
        cohortId: "cohort-order",
        sessionKey: laterHash.sessionKey,
        cursorStart: laterHash.cursorStart,
        cursorEnd: laterHash.cursorEnd,
        rowManifest: [],
        assignments: [laterHash, earlierHash].map((workset) => ({
          roleContractHash: "role-v1",
          workset,
        })),
      },
      L1_TEST_NOW,
    );
    expect(
      listL1CohortAssignments(root, "cohort-order").map(
        ({ assignmentId }) => assignmentId,
      ),
    ).toEqual(["l1a_z", "l1a_a"]);
  });

  it("binds approval to the exact receipt then commits the cohort", () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    expect(
      startL1AssignmentEpoch({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "run-1",
        roleContractHash: "role-v1",
        nowMs: 1,
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(true);
    const candidate = {
      assignmentId: workset.assignmentId,
      inputDigest: workset.inputDigest,
      scenes: [],
    };
    const reviewInput = { workset, candidate, conflicts: [] };
    const candidateDigest = digestL1Artifact(candidate);
    const reviewInputDigest = digestL1Artifact(reviewInput);
    createL1AttemptArtifact({
      dataDir: root,
      nowIso: L1_TEST_NOW,
      row: {
        attemptId: "attempt-1",
        assignmentId: workset.assignmentId,
        runId: "run-1",
        fence: 1,
        ordinal: 1,
        worksetDigest: digestL1Artifact(workset),
        reviewInputJson: JSON.stringify(reviewInput),
        reviewInputDigest,
        candidateJson: JSON.stringify(candidate),
        candidateDigest,
      },
    });
    expect(
      settleL1Attempt({
        dataDir: root,
        attemptId: "attempt-1",
        approved: true,
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(true);
    expect(
      approveL1Assignment({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "run-1",
        attemptId: "attempt-1",
        candidateDigest,
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(true);
    expect(
      markL1AssignmentCommitting({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "run-1",
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(true);
    expect(
      commitL1Assignment({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "run-1",
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(true);
    expect(commitL1Cohort(root, "cohort-1", L1_TEST_NOW)).toBe(true);
    expect(readOldestOpenL1Cohort(root, workset.sessionKey)).toBeNull();
    expect(
      readL1Assignment(root, workset.assignmentId)?.approvedAttemptId,
    ).toBe("attempt-1");
  });
});
