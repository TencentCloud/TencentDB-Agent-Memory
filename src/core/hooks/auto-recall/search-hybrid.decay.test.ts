/**
 * tz-10a Ф2b — a keyword-only hit from another project must be decayed.
 *
 * The hybrid merge used to store `scope: record.projectId` (a path) and never
 * set `project_id`, so `scopeDecayMultiplier` — which requires
 * `scope === "project"` (scope-decay.ts:82) — returned 1.0 for a row that only
 * the FTS leg found. Cross-project leakage in the deployed `decay` mode was
 * therefore invisible in exactly the path tz-10a has to measure.
 */
import { describe, it, expect } from "vitest";
import { searchHybrid } from "./search-hybrid.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const foreignRow: L1FtsResult = {
  record_id: "foreign-1",
  content: "a note that belongs to another project",
  type: "episodic",
  priority: 50,
  scene_name: "",
  score: 0.8,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "s",
  session_id: "s",
  metadata_json: "{}",
  project_id: "/home/penis/other-project",
  scope: "project",
};

/** FTS finds the foreign row; the vector leg finds nothing. */
function ftsOnlyStore(): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    searchL1Fts: async () => [foreignRow],
    searchL1Vector: async () => [],
    getCapabilities: () => ({ nativeHybridSearch: false }),
  } as unknown as IMemoryStore;
}

const fakeEmbedding: EmbeddingService = {
  embed: async () => new Float32Array(4),
} as unknown as EmbeddingService;

describe("hybrid: cross-project decay on the keyword leg", () => {
  it("downweights a foreign-project row that only FTS found", async () => {
    const result = await searchHybrid(
      "another project note",
      "/tmp",
      5,
      0,
      ftsOnlyStore(),
      fakeEmbedding,
      silentLogger,
      undefined,
      "/home/penis/this-project",
      undefined,
      { crossProjectDecay: 0.5, defaultCrossProjectMultiplier: 0.3 },
      "decay",
    );

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    // The row's own scope/project_id must survive the merge…
    expect(item.scope.scope).toBe("project");
    expect(item.scope.projectId).toBe("/home/penis/other-project");
    // …so the decay multiplier can actually fire (it was 1.0 before).
    expect(item.score.final).toBeLessThan(item.score.raw);
    expect(item.score.reasons.some((r) => r.startsWith("decay:"))).toBe(true);
    expect(item.score.reasons).not.toContain("decay:1");
  });
});
