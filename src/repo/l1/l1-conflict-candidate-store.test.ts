import { describe, expect, it, vi } from "vitest";
import type { L1CandidateMemoryV1 } from "../../core/record/l1-agent-types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { StoreL1ConflictCandidates } from "./l1-conflict-candidate-store.js";

const candidate: L1CandidateMemoryV1 = {
  candidateId: "candidate-1",
  content: "The user prefers dark mode",
  type: "persona",
  scope: "project",
  priority: 80,
  sourceMessageIds: ["m1"],
  metadata: {},
  action: "store",
  targetIds: [],
};

describe("StoreL1ConflictCandidates", () => {
  it("falls back from vector to FTS and pins same-scope snapshots", async () => {
    const searchL1Fts = vi.fn(async () => [
      {
        record_id: "existing-1",
        content: "Dark mode is preferred",
        type: "persona",
        priority: 80,
        scene_name: "preference",
        score: 0.91,
        timestamp_str: "2026-08-14T00:00:00.000Z",
        timestamp_start: "",
        timestamp_end: "",
        session_key: "s",
        session_id: "turn",
        metadata_json: '{"source":"prior"}',
        project_id: "/repo",
        scope: "project",
      },
    ]);
    const store = {
      isDegraded: () => false,
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
      }),
      searchL1Vector: vi.fn(async () => {
        throw new Error("vector unavailable");
      }),
      searchL1Fts,
      getL1ById: vi.fn(async () => ({
          record_id: "existing-1",
          content: "Dark mode is preferred",
          type: "persona",
          priority: 80,
          scene_name: "preference",
          session_key: "s",
          session_id: "turn",
          timestamp_str: "2026-08-14T00:00:00.000Z",
          timestamp_start: "",
          timestamp_end: "",
          created_time: "2026-08-14T00:00:00.000Z",
          updated_time: "2026-08-14T00:00:00.000Z",
          metadata_json: '{"source":"prior"}',
          project_id: "/repo",
          scope: "project",
      })),
    } as unknown as IMemoryStore;
    const repo = new StoreL1ConflictCandidates(
      () => store,
      () =>
        ({
          isReady: () => true,
          embed: async () => new Float32Array([1]),
        }) as never,
      { info() {}, warn() {}, error() {}, debug() {} },
    );
    const result = await repo.recall(candidate, "/repo");
    expect(result.matches).toMatchObject([
      {
        id: "existing-1",
        source: "fts",
        projectId: "/repo",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    expect(searchL1Fts).toHaveBeenCalledOnce();
    expect(result.nearDuplicateTargetId).toBeUndefined();
  });

  it("fails closed when an exact snapshot cannot be pinned", async () => {
    const store = {
      isDegraded: () => false,
      getCapabilities: () => ({
        vectorSearch: false,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
      }),
      searchL1Fts: async () => [{
        record_id: "existing-1", content: "dark", type: "persona", priority: 80,
        scene_name: "preference", score: 0.9, timestamp_str: "now",
        timestamp_start: "", timestamp_end: "", session_key: "s",
        session_id: "turn", metadata_json: "{}", project_id: "/repo",
        scope: "project",
      }],
      getL1ById: async () => { throw new Error("store unreadable"); },
    } as unknown as IMemoryStore;
    const repo = new StoreL1ConflictCandidates(
      () => store,
      () => undefined,
      { info() {}, warn() {}, error() {}, debug() {} },
    );
    await expect(repo.recall(candidate, "/repo")).rejects.toThrow(
      "store unreadable",
    );
  });
});
