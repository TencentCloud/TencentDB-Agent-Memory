import { afterEach, describe, expect, it } from "vitest";
import { listAttempts } from "../control-plane/attempt-repo.js";
import { readL1Assignment } from "./l1-assignment-repo.js";
import { readLatestL1Status } from "./l1-status-repo.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { createTestL1Dispatcher } from "./l1-dispatch-fixture.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("agentic L1 dispatcher", () => {
  it("persists an exact extractor and critic receipt", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const result = await createTestL1Dispatcher(
      root,
      "approve",
    ).dispatchExtraction({ role: "l1-extractor", workset });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readL1Assignment(root, workset.assignmentId)?.state).toBe(
      "reviewed",
    );
    expect(
      listAttempts(root, result.runId).map(({ outcome }) => outcome),
    ).toEqual(["succeeded", "succeeded"]);
    expect(readLatestL1Status(root)).toMatchObject({
      assignmentState: "reviewed",
      runState: "reviewed",
      errorKind: null,
      extractorOutcome: "succeeded",
      criticOutcome: "succeeded",
      criticVerdict: "approve",
      commitState: "not-started",
    });
  });

  it("fails closed when the critic rejects", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const result = await createTestL1Dispatcher(
      root,
      "reject",
    ).dispatchExtraction({ role: "l1-extractor", workset });
    expect(result).toMatchObject({ ok: false, kind: "critic-rejected" });
    expect(readL1Assignment(root, workset.assignmentId)?.state).toBe("failed");
    expect(readLatestL1Status(root)?.errorKind).toBe("critic-rejected");
  });

  it("spends the role retry budget inside one Run epoch", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const result = await createTestL1Dispatcher(root, [
      "reject",
      "approve",
    ]).dispatchExtraction({ role: "l1-extractor", workset });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listAttempts(root, result.runId)).toHaveLength(4);
    expect(readL1Assignment(root, workset.assignmentId)?.failureCount).toBe(0);
  });

  it("rejects an approved store when parent recall marks a near duplicate", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    const dispatcher = createTestL1Dispatcher(root, "approve");
    const row = {
      record_id: "existing-dark-mode",
      content: "The user prefers dark mode.",
      type: "persona",
      priority: 80,
      scene_name: "preference",
      score: 0.99,
      timestamp_str: "2026-08-14T00:00:00.000Z",
      timestamp_start: "",
      timestamp_end: "",
      session_key: "old",
      session_id: "old",
      metadata_json: "{}",
      project_id: "/repo",
      scope: "project",
    };
    dispatcher.configureRecallContext({
      vectorStore: {
        isDegraded: () => false,
        getCapabilities: () => ({
          vectorSearch: true,
          ftsSearch: false,
          nativeHybridSearch: false,
          sparseVectors: false,
        }),
        searchL1Vector: async () => [row],
        getL1ById: async () => ({
          ...row,
          created_time: row.timestamp_str,
          updated_time: row.timestamp_str,
        }),
        queryL1Records: async () => [
          {
            ...row,
            created_time: row.timestamp_str,
            updated_time: row.timestamp_str,
          },
        ],
      } as unknown as IMemoryStore,
      embeddingService: {
        isReady: () => true,
        embed: async () => new Float32Array([1]),
      } as never,
    });
    const result = await dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset,
    });
    expect(result).toMatchObject({ ok: false, kind: "critic-rejected" });
    expect(listAttempts(root, readL1Assignment(root, workset.assignmentId)!.runId!)).toHaveLength(4);
  });

  it("keeps the extractor role single-flight across assignments", async () => {
    const root = createL1TestDataDir(roots);
    const firstWorkset = createL1TestCohort(root, "l1a_first", "cohort-first");
    const secondWorkset = createL1TestCohort(root, "l1a_second", "cohort-second");
    const dispatcher = createTestL1Dispatcher(root, "approve");
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
