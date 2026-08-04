/**
 * P10 — recall typeWeights rerank (improvement #2, ТЗ §5.15 / критерий 13).
 *
 * Two layers:
 *   1. `applyTypeWeights` — pure rerank unit tests (off = identity).
 *   2. `searchMemoriesWithDetails` with a fake vector store — the rerank
 *      actually changes top-1 when instruction/persona weights > 1, and the
 *      default (all 1.0) preserves the current cosine order.
 */
import { describe, it, expect } from "vitest";
import { parseConfig, type MemoryTdaiConfig } from "../../config.js";
import { applyTypeWeights, searchMemoriesWithDetails } from "./auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";

const silentLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function makeConfig(overrides: Record<string, unknown>): MemoryTdaiConfig {
  return parseConfig({
    recall: {
      strategy: "embedding",
      scoreThreshold: 0.5,
      maxResults: 3,
      ...overrides,
    },
  });
}

describe("applyTypeWeights (pure)", () => {
  const items = [
    { id: "a", score: 0.9, type: "episodic" },
    { id: "b", score: 0.8, type: "instruction" },
    { id: "c", score: 0.7, type: "persona" },
    { id: "d", score: 0.85, type: "unknown-type" },
  ];

  it("undefined weights → returns the same array unchanged (off)", () => {
    expect(applyTypeWeights(items, undefined)).toBe(items);
  });

  it("all-1.0 weights → returns the same array unchanged (default = current behavior)", () => {
    expect(applyTypeWeights(items, { instruction: 1, persona: 1, episodic: 1 })).toBe(items);
  });

  it("instruction=1.2 lifts an instruction record above a higher-cosine episodic", () => {
    const reranked = applyTypeWeights(items, { instruction: 1.2, persona: 1.1, episodic: 1.0 });
    expect(reranked[0]!.id).toBe("b"); // 0.96 > 0.9
    expect(reranked[1]!.id).toBe("a"); // 0.9
    expect(reranked[2]!.id).toBe("d"); // 0.85 (unknown → 1.0)
    expect(reranked[3]!.id).toBe("c"); // 0.7 * 1.1 = 0.77
  });

  it("unknown types get weight 1.0", () => {
    const reranked = applyTypeWeights(items, { instruction: 1.2, persona: 1.1, episodic: 1.0 });
    // d (0.85, unknown → 0.85) sits between b (0.96) and a (0.9)... no: 0.85 < 0.9 → after a
    expect(reranked.map((i) => i.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("stable for ties (original score order preserved)", () => {
    const tied = [
      { id: "x", score: 1.0, type: "instruction" },
      { id: "y", score: 1.0, type: "episodic" },
    ];
    const reranked = applyTypeWeights(tied, { instruction: 1.2, persona: 1.0, episodic: 1.0 });
    expect(reranked[0]!.id).toBe("x");
    expect(reranked[1]!.id).toBe("y");
  });
});

// ============================
// Fake store + embedding
// ============================

function fakeStore(results: L1SearchResult[]): IMemoryStore {
  return {
    searchL1Vector: async () => results,
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
  } as unknown as IMemoryStore;
}

const fakeEmbedding: EmbeddingService = {
  embed: async () => new Float32Array(4),
} as unknown as EmbeddingService;

const candidate = (id: string, type: string, score: number): L1SearchResult => ({
  record_id: id,
  content: `${type} content for ${id}`,
  type,
  priority: 50,
  scene_name: "",
  score,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "s",
  session_id: "s",
  metadata_json: "{}",
});

describe("searchMemoriesWithDetails rerank integration (embedding strategy)", () => {
  const cfg = makeConfig({});
  const strategy = "embedding" as const;

  it("default weights (all 1.0): top-1 stays the highest-cosine episodic (current behavior)", async () => {
    const store = fakeStore([candidate("ep1", "episodic", 0.9), candidate("in1", "instruction", 0.8)]);
    const r = await searchMemoriesWithDetails("query", "/tmp", cfg, silentLogger, strategy, store, fakeEmbedding);
    expect(r.memories[0]!.type).toBe("episodic");
    expect(r.memories[0]!.content).toContain("ep1");
  });

  it("typeWeights instruction=1.2: top-1 becomes the instruction record", async () => {
    const weighted = makeConfig({ typeWeights: { instruction: 1.2, persona: 1.1, episodic: 1.0 } });
    const store = fakeStore([candidate("ep1", "episodic", 0.9), candidate("in1", "instruction", 0.8)]);
    const r = await searchMemoriesWithDetails("query", "/tmp", weighted, silentLogger, strategy, store, fakeEmbedding);
    expect(r.memories[0]!.type).toBe("instruction");
    expect(r.memories[0]!.content).toContain("in1");
    expect(r.memories[1]!.type).toBe("episodic");
  });

  it("threshold still applies BEFORE the rerank (no below-threshold promotion)", async () => {
    const weighted = makeConfig({
      typeWeights: { instruction: 5, persona: 1.1, episodic: 1.0 },
      scoreThreshold: 0.9,
    });
    // instruction score 0.8 → filtered out by threshold even though 0.8*5=4.0
    const store = fakeStore([candidate("ep1", "episodic", 0.95), candidate("in1", "instruction", 0.8)]);
    const r = await searchMemoriesWithDetails("query", "/tmp", weighted, silentLogger, strategy, store, fakeEmbedding);
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.type).toBe("episodic");
  });
});

// ============================
// Cross-project scope decay integration
// ============================

describe("searchMemories crossProject integration", () => {
  it("hidden mode: cross-project records are filtered out (back-compat)", async () => {
    const cfg = makeConfig({ crossProject: "hidden" });
    const crossStore = fakeStore([
      { record_id: "a", content: "a content", type: "episodic", priority: 50, scene_name: "", score: 0.9, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis/projects/u24", scope: "project" },
      { record_id: "b", content: "b content", type: "episodic", priority: 50, scene_name: "", score: 0.85, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis", scope: "project" },
      { record_id: "c", content: "c content", type: "episodic", priority: 50, scene_name: "", score: 0.8, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis/projects/base-extention", scope: "project" },
    ]);
    const r = await searchMemoriesWithDetails("query", "/tmp", cfg, silentLogger, "embedding", crossStore, fakeEmbedding, "/home/penis");
    const ids = r.memories.map((m) => m.content.split(" ")[0]);
    expect(ids).toEqual(["b"]);
  });

  it("decay mode: cross-project records surface; order is by post-multiplier score", async () => {
    const cfg = makeConfig({ crossProject: "decay", scoreThreshold: 0.1, maxResults: 3 });
    const crossStore = fakeStore([
      { record_id: "a", content: "a content", type: "episodic", priority: 50, scene_name: "", score: 0.9, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis/projects/u24", scope: "project" },
      { record_id: "b", content: "b content", type: "episodic", priority: 50, scene_name: "", score: 0.85, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis", scope: "project" },
      { record_id: "c", content: "c content", type: "episodic", priority: 50, scene_name: "", score: 0.5, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/home/penis/projects/base-extention", scope: "project" },
      { record_id: "d", content: "d content", type: "episodic", priority: 50, scene_name: "", score: 0.3, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "/cosmic", scope: "project" },
      { record_id: "g", content: "g content", type: "episodic", priority: 50, scene_name: "", score: 0.7, timestamp_str: "", timestamp_start: "", timestamp_end: "", session_key: "s", session_id: "s", metadata_json: "{}", project_id: "", scope: "global" },
    ]);
    const r = await searchMemoriesWithDetails("query", "/tmp", cfg, silentLogger, "embedding", crossStore, fakeEmbedding, "/home/penis");
    expect(r.memories.length).toBe(3);
    const order = r.memories.map((m) => m.content.split(" ")[0]);
    expect(order).toEqual(["b", "g", "a"]);
  });
});
