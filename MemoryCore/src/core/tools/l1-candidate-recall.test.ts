/**
 * L1 hybrid ranking + scoreThreshold.
 *
 * scoreThreshold is the 0–1 cutoff keyword (BM25) and embedding (cosine)
 * already use. Hybrid must apply it to those source scores and must not
 * re-rank the survivors: RRF still runs on the full candidate lists, then
 * hits that fail the cutoff are dropped. Native server hybrid returns RRF
 * scores (~0.02), which are not on that scale and stay top-N.
 */
import { describe, expect, it } from "vitest";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";
import { recallL1Candidates } from "./l1-candidate-recall.js";

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

function clientStore(opts: {
  fts?: L1SearchResult[];
  vector?: L1SearchResult[];
  ftsAvailable?: boolean;
}): IMemoryStore {
  return {
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: opts.ftsAvailable !== false,
      nativeHybridSearch: false,
      sparseVectors: false,
      profileRows: false,
    }),
    isFtsAvailable: () => opts.ftsAvailable !== false,
    searchL1Fts: async () => opts.fts ?? [],
    searchL1Vector: async () => opts.vector ?? [],
  } as unknown as IMemoryStore;
}

describe("recallL1Candidates scoreThreshold", () => {
  it("drops a below-threshold FTS hit without re-ranking the survivors", async () => {
    // FTS ranks: x=0, a=1, b=2. Vector ranks: b=0, a=1.
    // Unfiltered RRF (k=60): b = 1/63+1/61, a = 1/62+1/62, x = 1/61.
    // b stays ahead of a. x (FTS 0.1 only) is ineligible at threshold 0.3.
    // Pre-filtering x before RRF would tie a and b and let stable sort put a first.
    const fts = [l1("x", "weak", 0.1), l1("a", "alpha", 0.9), l1("b", "beta", 0.8)];
    const vector = [l1("b", "beta", 0.9), l1("a", "alpha", 0.8)];
    const { hits } = await recallL1Candidates({
      query: "alpha beta",
      topK: 15,
      vectorStore: clientStore({ fts, vector }),
      embeddingService: embedding,
      scoreThreshold: 0.3,
      ftsSmallSetLimit: 5,
    });

    expect(hits.map((h) => h.record_id)).toEqual(["b", "a"]);
    expect(hits[0].score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(hits[1].score).toBeCloseTo(1 / 62 + 1 / 62, 10);
  });

  it("keeps a tiny all-below-threshold FTS set and still drops weak vector-only hits", async () => {
    // Keyword keeps a result set no larger than maxResults when nothing clears
    // the cutoff (BM25 is unreliable there). Embedding never does.
    const fts = [l1("p", "kept-fts", 0.05), l1("q", "kept-fts-2", 0.06)];
    const vector = [l1("p", "kept-fts", 0.1), l1("s", "dropped-vec", 0.1), l1("r", "kept-vec", 0.8)];
    const { hits } = await recallL1Candidates({
      query: "alpha beta",
      topK: 15,
      vectorStore: clientStore({ fts, vector }),
      embeddingService: embedding,
      scoreThreshold: 0.3,
      ftsSmallSetLimit: 5,
    });

    expect(hits.map((h) => h.record_id)).toEqual(["p", "q", "r"]);
  });

  it("returns nothing when every FTS score is below threshold and the set is larger than the small-set limit", async () => {
    const fts = Array.from({ length: 8 }, (_, i) => l1(`f${i}`, `mem-${i}`, 0.05));
    const { hits } = await recallL1Candidates({
      query: "alpha beta",
      topK: 15,
      vectorStore: clientStore({ fts, vector: [] }),
      embeddingService: embedding,
      scoreThreshold: 0.3,
      ftsSmallSetLimit: 5,
    });

    expect(hits).toEqual([]);
  });

  it("drops vector-only hits below threshold even when the set is small", async () => {
    const vector = [l1("v1", "low-vec", 0.1), l1("v2", "low-vec-2", 0.2)];
    const { hits } = await recallL1Candidates({
      query: "alpha beta",
      topK: 15,
      vectorStore: clientStore({ ftsAvailable: false, vector }),
      embeddingService: embedding,
      scoreThreshold: 0.3,
      ftsSmallSetLimit: 5,
    });

    expect(hits).toEqual([]);
  });

  it("leaves ranking unchanged when scoreThreshold is omitted", async () => {
    const fts = [l1("x", "weak", 0.1), l1("a", "alpha", 0.9)];
    const vector = [l1("a", "alpha", 0.8)];
    const { hits } = await recallL1Candidates({
      query: "alpha beta",
      topK: 15,
      vectorStore: clientStore({ fts, vector }),
      embeddingService: embedding,
    });

    expect(hits.map((h) => h.record_id)).toEqual(["a", "x"]);
  });

  it("does not apply scoreThreshold to native hybrid scores", async () => {
    const nativeHits = [l1("n1", "native-hit", 0.02), l1("n2", "native-second", 0.015)];
    const store = {
      getCapabilities: () => ({
        vectorSearch: true,
        ftsSearch: true,
        nativeHybridSearch: true,
        sparseVectors: true,
        profileRows: false,
      }),
      isFtsAvailable: () => true,
      searchL1Hybrid: async () => nativeHits,
      searchL1Fts: async () => {
        throw new Error("native path must not call FTS");
      },
      searchL1Vector: async () => {
        throw new Error("native path must not call vector search");
      },
    } as unknown as IMemoryStore;

    const { hits, strategy } = await recallL1Candidates({
      query: "alpha beta",
      topK: 3,
      vectorStore: store,
      scoreThreshold: 0.3,
      ftsSmallSetLimit: 5,
    });

    expect(strategy).toBe("hybrid");
    expect(hits.map((h) => h.record_id)).toEqual(["n1", "n2"]);
    expect(hits[0].score).toBeCloseTo(0.02, 10);
  });
});
