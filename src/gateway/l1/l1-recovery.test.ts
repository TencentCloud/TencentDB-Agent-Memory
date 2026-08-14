import { afterEach, describe, expect, it } from "vitest";
import { claimRun } from "../control-plane/lease.js";
import { runOwnerId } from "../control-plane/owner.js";
import { createRun, readRun } from "../control-plane/run-repo.js";
import {
  readL1Assignment,
  startL1AssignmentEpoch,
} from "./l1-assignment-repo.js";
import { recoverL1Assignment } from "./l1-recovery.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("L1 assignment recovery", () => {
  it("turns a dead running epoch into an immediately retryable failure", () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const now = Date.now();
    expect(
      startL1AssignmentEpoch({
        dataDir: root,
        assignmentId: workset.assignmentId,
        runId: "dead-run",
        roleContractHash: "role-v1",
        nowMs: now,
        nowIso: new Date(now).toISOString(),
      }),
    ).toBe(true);
    createRun(
      root,
      {
        runId: "dead-run",
        assignmentId: workset.assignmentId,
        roleId: "l1-extractor",
        contractHash: "role-v1",
        contractJson: "{}",
        binding: "{}",
      },
      new Date(now).toISOString(),
    );
    expect(
      claimRun(root, "dead-run", runOwnerId(2_147_483_647), {
        nowMs: now,
        ttlMs: 300_000,
        state: "running",
      }).ok,
    ).toBe(true);

    const recovered = recoverL1Assignment(
      root,
      readL1Assignment(root, workset.assignmentId)!,
      now + 1,
    );

    expect(recovered).toMatchObject({ state: "failed", failureCount: 1 });
    expect(recovered.nextRetryAt).toBe(now + 1);
    expect(readRun(root, "dead-run")?.state).toBe("failed");
  });

  it("does not steal a live running epoch", () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const now = Date.now();
    startL1AssignmentEpoch({
      dataDir: root,
      assignmentId: workset.assignmentId,
      runId: "live-run",
      roleContractHash: "role-v1",
      nowMs: now,
      nowIso: new Date(now).toISOString(),
    });
    createRun(
      root,
      {
        runId: "live-run",
        assignmentId: workset.assignmentId,
        roleId: "l1-extractor",
        contractHash: "role-v1",
        contractJson: "{}",
        binding: "{}",
      },
      new Date(now).toISOString(),
    );
    claimRun(root, "live-run", runOwnerId(process.pid), {
      nowMs: now,
      ttlMs: 300_000,
      state: "running",
    });

    expect(
      recoverL1Assignment(
        root,
        readL1Assignment(root, workset.assignmentId)!,
        now + 1,
      ).state,
    ).toBe("running");
  });
});
