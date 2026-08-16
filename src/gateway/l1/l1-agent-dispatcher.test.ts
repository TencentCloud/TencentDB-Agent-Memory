import { afterEach, describe, expect, it } from "vitest";
import { listAttempts } from "../control-plane/attempt-repo.js";
import { readL1Assignment } from "./l1-assignment-repo.js";
import { readLatestL1Status } from "./l1-status-repo.js";
import {
  configureNearDuplicateRecall,
  createTestL1Dispatcher,
  invalidOutputLauncher,
  retryAwareLauncher,
} from "./l1-dispatch-fixture.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("agentic L1 dispatcher", () => {
  it("persists an approved extractor artifact", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const result = await createTestL1Dispatcher(root).dispatchExtraction({
      role: "l1-extractor",
      workset,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readL1Assignment(root, workset.assignmentId)?.state).toBe(
      "reviewed",
    );
    expect(
      listAttempts(root, result.runId).map(({ outcome }) => outcome),
    ).toEqual(["succeeded"]);
    expect(readLatestL1Status(root)).toMatchObject({
      assignmentState: "reviewed",
      runState: "reviewed",
      errorKind: null,
      extractorOutcome: "succeeded",
      commitState: "not-started",
    });
  });

  it("fails closed when the role output is not a valid candidate", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const result = await createTestL1Dispatcher(
      root,
      invalidOutputLauncher(),
    ).dispatchExtraction({ role: "l1-extractor", workset });
    expect(result).toMatchObject({ ok: false, kind: "invalid-candidate" });
    expect(readL1Assignment(root, workset.assignmentId)?.state).toBe("failed");
    expect(readLatestL1Status(root)?.errorKind).toBe("invalid-candidate");
  });

  it("spends the role retry budget inside one Run epoch", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const dispatcher = createTestL1Dispatcher(root, retryAwareLauncher());
    configureNearDuplicateRecall(dispatcher);
    const result = await dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listAttempts(root, result.runId)).toHaveLength(2);
    expect(readL1Assignment(root, workset.assignmentId)?.failureCount).toBe(0);
  });

  it("rejects a fresh store when parent recall marks a near duplicate", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const dispatcher = createTestL1Dispatcher(root);
    configureNearDuplicateRecall(dispatcher);
    const result = await dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset,
    });
    expect(result).toMatchObject({ ok: false, kind: "policy-rejected" });
    expect(
      listAttempts(root, readL1Assignment(root, workset.assignmentId)!.runId!),
    ).toHaveLength(2);
  });

  it("keeps the extractor role single-flight across assignments", async () => {
    const root = createL1TestDataDir(roots);
    const firstWorkset = createL1TestCohort(root, "l1a_first", "cohort-first");
    const secondWorkset = createL1TestCohort(
      root,
      "l1a_second",
      "cohort-second",
    );
    const dispatcher = createTestL1Dispatcher(root);
    const first = dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset: firstWorkset,
    });
    const second = await dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset: secondWorkset,
    });
    expect(second).toMatchObject({ ok: false, kind: "busy" });
    expect((await first).ok).toBe(true);
  });
});
