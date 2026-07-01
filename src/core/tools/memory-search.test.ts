import { describe, expect, it } from "vitest";
import { executeMemorySearch } from "./memory-search.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../store/types.js";
import type { Logger } from "../types.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function l1Result(overrides: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: "record-1",
    content: "prefers safe database migrations",
    type: "instruction",
    priority: 1,
    scene_name: "work",
    score: 0.9,
    timestamp_str: "2026-07-01T00:00:00.000Z",
    timestamp_start: "2026-07-01T00:00:00.000Z",
    timestamp_end: "2026-07-01T00:00:00.000Z",
    session_key: "session-a",
    session_id: "session-a-id",
    metadata_json: "{}",
    ...overrides,
  };
}

function createStore(opts: {
  fts?: L1FtsResult[];
  vector?: L1SearchResult[];
  ftsAvailable?: boolean;
}): { store: IMemoryStore; ftsLimits: number[]; vectorLimits: number[] } {
  const ftsLimits: number[] = [];
  const vectorLimits: number[] = [];
  const store = {
    isFtsAvailable: () => opts.ftsAvailable ?? true,
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: opts.ftsAvailable ?? true,
      nativeHybridSearch: false,
      sparseVectors: false,
    }),
    searchL1Fts: (_query: string, limit = 10) => {
      ftsLimits.push(limit);
      return opts.fts ?? [];
    },
    searchL1Vector: (_embedding: Float32Array, limit = 10) => {
      vectorLimits.push(limit);
      return opts.vector ?? [];
    },
  } as unknown as IMemoryStore;
  return { store, ftsLimits, vectorLimits };
}

const embeddingService: EmbeddingService = {
  embed: async () => new Float32Array([0.1, 0.2, 0.3]),
  embedBatch: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
  getDimensions: () => 3,
  getProviderInfo: () => ({ provider: "test", model: "fake" }),
  isReady: () => true,
  startWarmup: () => {},
};

describe("executeMemorySearch session filtering", () => {
  it("filters L1 FTS results to the requested session after over-retrieval", async () => {
    const { store, ftsLimits } = createStore({
      fts: [
        l1Result({ record_id: "other-high-score", session_key: "session-b", score: 0.99 }),
        l1Result({ record_id: "match-1", session_key: "session-a", score: 0.8 }),
        l1Result({ record_id: "match-2", session_key: "session-a", score: 0.7 }),
      ],
    });

    const result = await executeMemorySearch({
      query: "safe database migrations",
      limit: 2,
      sessionKey: "session-a",
      vectorStore: store,
      logger,
    });

    expect(ftsLimits).toEqual([10]);
    expect(result.strategy).toBe("fts");
    expect(result.results.map((r) => r.id)).toEqual(["match-1", "match-2"]);
    expect(result.results.every((r) => r.session_key === "session-a")).toBe(true);
  });

  it("keeps unscoped memory search global when no session key is provided", async () => {
    const { store, ftsLimits } = createStore({
      fts: [
        l1Result({ record_id: "session-b-memory", session_key: "session-b", score: 0.99 }),
        l1Result({ record_id: "session-a-memory", session_key: "session-a", score: 0.8 }),
      ],
    });

    const result = await executeMemorySearch({
      query: "safe database migrations",
      limit: 2,
      vectorStore: store,
      logger,
    });

    expect(ftsLimits).toEqual([6]);
    expect(result.results.map((r) => r.id)).toEqual(["session-b-memory", "session-a-memory"]);
  });

  it("filters merged hybrid results so vector-only cross-session hits do not leak", async () => {
    const { store, ftsLimits, vectorLimits } = createStore({
      fts: [
        l1Result({ record_id: "shared-match", session_key: "session-a", score: 0.7 }),
        l1Result({ record_id: "other-fts", session_key: "session-b", score: 0.6 }),
      ],
      vector: [
        l1Result({ record_id: "other-vector", session_key: "session-b", score: 0.98 }),
        l1Result({ record_id: "shared-match", session_key: "session-a", score: 0.9 }),
        l1Result({ record_id: "vector-match", session_key: "session-a", score: 0.85 }),
      ],
    });

    const result = await executeMemorySearch({
      query: "safe database migrations",
      limit: 3,
      sessionKey: "session-a",
      vectorStore: store,
      embeddingService,
      logger,
    });

    expect(ftsLimits).toEqual([15]);
    expect(vectorLimits).toEqual([15]);
    expect(result.strategy).toBe("hybrid");
    expect(result.results.map((r) => r.id)).toEqual(["shared-match", "vector-match"]);
    expect(result.results.every((r) => r.session_key === "session-a")).toBe(true);
  });
});
