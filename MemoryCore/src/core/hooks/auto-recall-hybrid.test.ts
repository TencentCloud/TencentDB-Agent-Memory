/**
 * /recall hybrid must rank like tdai_memory_search and honor scoreThreshold
 * on client-side FTS / vector scores.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";
import { executeMemorySearch } from "../tools/memory-search.js";

function l1(recordId: string, content: string, score: number): L1SearchResult {
  return {
    record_id: recordId,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 0,
    session_key: "s",
    session_id: "sid",
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "{}",
  };
}

const embedding: EmbeddingService = {
  embed: async () => new Float32Array([1, 0]),
  embedBatch: async (texts) => texts.map(() => new Float32Array([1, 0])),
  getDimensions: () => 2,
  getProviderInfo: () => ({ provider: "test", model: "test" }),
};

function recallCfg(partial: Partial<MemoryTdaiConfig["recall"]> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      maxResults: 5,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      scoreThreshold: 0.3,
      strategy: "hybrid",
      timeoutMs: 5_000,
      ...partial,
    },
  } as MemoryTdaiConfig;
}

let pluginDataDir = "";

beforeAll(async () => {
  pluginDataDir = await mkdtemp(path.join(tmpdir(), "recall-hybrid-"));
});

afterAll(async () => {
  if (pluginDataDir) await rm(pluginDataDir, { recursive: true, force: true });
});

describe("/recall hybrid vs tdai_memory_search", () => {
  it("returns the same native-hybrid head as the tool, including sub-0.3 server scores", async () => {
    // Asking the backend for topK=1 vs topK=3 changes who wins RRF.
    // The tool over-fetches; /recall must do the same. Scores stay the
    // backend RRF values (0.021 < scoreThreshold 0.3) — not filtered.
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: true,
        sparseVectors: true,
        profileRows: false,
      }),
      isFtsAvailable: () => false,
      searchL1Hybrid: async (params: { topK?: number }) => {
        if ((params.topK ?? 0) <= 1) return [l1("narrow", "narrow-only", 0.02)];
        return [l1("wide", "shared-head", 0.021), l1("narrow", "narrow-only", 0.02)];
      },
    } as unknown as IMemoryStore;

    const tool = await executeMemorySearch({
      query: "project roadmap",
      limit: 1,
      vectorStore: store,
      logger: undefined,
    });
    const recall = await performAutoRecall({
      userText: "project roadmap",
      actorId: "actor",
      sessionKey: "sess",
      cfg: recallCfg({ maxResults: 1, scoreThreshold: 0.3 }),
      pluginDataDir,
      vectorStore: store,
    });

    expect(tool.results.map((r) => r.content)).toEqual(["shared-head"]);
    expect(tool.results[0].score).toBeCloseTo(0.021, 8);
    expect(recall?.recalledL1Memories?.map((m) => m.content)).toEqual(["shared-head"]);
    expect(recall?.recalledL1Memories?.[0].score).toBeCloseTo(0.021, 8);
  });

  it("drops a client hit below scoreThreshold and keeps the tool's order for the rest", async () => {
    // FTS: weak rank 0, strong rank 1. Vector: strong rank 0, other rank 1.
    // Tool top-N is strong, weak, other. Recall must omit weak (FTS 0.1)
    // and keep strong then other.
    const fts = [l1("w", "weak-keyword", 0.1), l1("s", "strong-keyword", 0.8)];
    const vector = [l1("s", "strong-keyword", 0.85), l1("o", "other-vector", 0.6)];
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
        profileRows: false,
      }),
      isFtsAvailable: () => true,
      searchL1Fts: async () => fts,
      searchL1Vector: async () => vector,
    } as unknown as IMemoryStore;

    const tool = await executeMemorySearch({
      query: "project roadmap",
      limit: 5,
      vectorStore: store,
      embeddingService: embedding,
    });
    const recall = await performAutoRecall({
      userText: "project roadmap",
      actorId: "actor",
      sessionKey: "sess",
      cfg: recallCfg({ maxResults: 5, scoreThreshold: 0.3 }),
      pluginDataDir,
      vectorStore: store,
      embeddingService: embedding,
    });

    expect(tool.results.map((r) => r.content)).toEqual([
      "strong-keyword",
      "weak-keyword",
      "other-vector",
    ]);
    expect(recall?.recalledL1Memories?.map((m) => m.content)).toEqual([
      "strong-keyword",
      "other-vector",
    ]);
  });

  it("reports the same client RRF scores as the tool when every source score clears the threshold", async () => {
    // FTS a, b, c. Vector c, d. All source scores 0.9.
    // c = 1/63+1/61, a = 1/61, b = 1/62, d = 1/62.
    // Stable sort inserts FTS before vector, so b stays ahead of d.
    const fts = [l1("a", "aaa", 0.9), l1("b", "bbb", 0.9), l1("c", "ccc", 0.9)];
    const vector = [l1("c", "ccc", 0.9), l1("d", "ddd", 0.9)];
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
        profileRows: false,
      }),
      isFtsAvailable: () => true,
      searchL1Fts: async () => fts,
      searchL1Vector: async () => vector,
    } as unknown as IMemoryStore;

    const tool = await executeMemorySearch({
      query: "project roadmap",
      limit: 5,
      vectorStore: store,
      embeddingService: embedding,
    });
    const recall = await performAutoRecall({
      userText: "project roadmap",
      actorId: "actor",
      sessionKey: "sess",
      cfg: recallCfg({ maxResults: 5, scoreThreshold: 0.3 }),
      pluginDataDir,
      vectorStore: store,
      embeddingService: embedding,
    });

    const wantIds = ["c", "a", "b", "d"];
    const wantScores = [1 / 63 + 1 / 61, 1 / 61, 1 / 62, 1 / 62];
    expect(tool.results.map((r) => r.id)).toEqual(wantIds);
    expect(recall?.recalledL1Memories?.map((m) => m.content)).toEqual(["ccc", "aaa", "bbb", "ddd"]);
    tool.results.forEach((row, i) => {
      expect(row.score).toBeCloseTo(wantScores[i], 8);
    });
    recall?.recalledL1Memories?.forEach((row, i) => {
      expect(row.score).toBeCloseTo(wantScores[i], 8);
    });
  });

  it("keeps a single below-threshold FTS memory the way keyword recall does", async () => {
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
        profileRows: false,
      }),
      isFtsAvailable: () => true,
      searchL1Fts: async () => [l1("only", "only-memory", 0.05)],
      searchL1Vector: async () => [],
    } as unknown as IMemoryStore;

    const recall = await performAutoRecall({
      userText: "project roadmap",
      actorId: "actor",
      sessionKey: "sess",
      cfg: recallCfg({ maxResults: 5, scoreThreshold: 0.3 }),
      pluginDataDir,
      vectorStore: store,
      embeddingService: embedding,
    });

    expect(recall?.recalledL1Memories?.map((m) => m.content)).toEqual(["only-memory"]);
  });

  it("drops a large all-below-threshold FTS set instead of returning top-N", async () => {
    // Keyword recall fetches maxResults*2 and, when nothing clears 0.3 and the
    // hit count exceeds maxResults, returns nothing. Hybrid must do the same
    // — not keep the weak list just because the candidate window is 3x.
    const fts = Array.from({ length: 8 }, (_, i) => l1(`f${i}`, `weak-${i}`, 0.05));
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: false,
        sparseVectors: false,
        profileRows: false,
      }),
      isFtsAvailable: () => true,
      searchL1Fts: async () => fts,
      searchL1Vector: async () => [],
    } as unknown as IMemoryStore;

    const recall = await performAutoRecall({
      userText: "project roadmap",
      actorId: "actor",
      sessionKey: "sess",
      cfg: recallCfg({ maxResults: 5, scoreThreshold: 0.3 }),
      pluginDataDir,
      vectorStore: store,
      embeddingService: embedding,
    });

    expect(recall?.recalledL1Memories ?? []).toEqual([]);
  });
});
