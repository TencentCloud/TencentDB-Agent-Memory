import { afterEach, describe, expect, it } from "vitest";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import { startL1AssignmentEpoch } from "./l1-assignment-repo.js";
import {
  approveL1Assignment,
  createL1AttemptArtifact,
  settleL1Attempt,
} from "./l1-attempt-repo.js";
import { commitL1Cohort } from "./l1-cohort-repo.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  L1_TEST_NOW,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("L1 candidate digest binding", () => {
  it("refuses approval when the stored candidate is not the one validated", () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    startL1AssignmentEpoch({
      dataDir: root,
      assignmentId: workset.assignmentId,
      runId: "run-1",
      roleContractHash: "role-v1",
      nowMs: 1,
      nowIso: L1_TEST_NOW,
    });
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
        reviewInputJson: "{}",
        reviewInputDigest: digestL1Artifact({ expected: true }),
        candidateJson: "{}",
        candidateDigest: digestL1Artifact({}),
      },
    });
    settleL1Attempt({
      dataDir: root,
      attemptId: "attempt-1",
      approved: true,
      nowIso: L1_TEST_NOW,
    });
    expect(
      approveL1Assignment({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "run-1",
        attemptId: "attempt-1",
        candidateDigest: digestL1Artifact({ wrong: true }),
        nowIso: L1_TEST_NOW,
      }),
    ).toBe(false);
    expect(commitL1Cohort(root, "cohort-1", L1_TEST_NOW)).toBe(false);
  });
});
