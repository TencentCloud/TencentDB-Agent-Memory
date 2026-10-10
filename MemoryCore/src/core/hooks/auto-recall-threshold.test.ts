/**
 * Regression tests for recall.scoreThreshold per-strategy semantics (#1296).
 *
 * The three strategies use different score scales:
 *   - keyword:  FTS5 BM25 mapped to 0–1 (bm25RankToScore) → threshold APPLIES
 *   - embedding: cosine 1-distance, 0–1                    → threshold APPLIES
 *   - hybrid:   fused RRF scores ≈ 1/(60+rank) ≈ 0.016–0.05, a RANKING
 *     signal on a different scale — the threshold is deliberately NOT
 *     applied; hybrid relies on top-N.
 *
 * These tests pin that split so a future refactor cannot silently start
 * filtering fused results with a 0–1 threshold (which would empty hybrid
 * recall entirely) — or stop filtering the single-source paths.
 */
import { describe, expect, it, vi } from "vitest";
import { searchMemories } from "./auto-recall.js";
import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";

const cfg = parseConfig({});

function makeLogger(): { logger: Logger; debugLines: string[] } {
  const debugLines: string[] = [];
  const logger = {
    debug: (msg?: string) => {
      debugLines.push(String(msg));
    },
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
  return { logger, debugLines };
}

function l1Result(id: string, score: number): L1SearchResult {
  return {
    record_id: id,
    content: `记忆 ${id}`,
    type: "persona",
    priority: 80,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "s",
    session_id: "sid",
    team_id: "",
    metadata_json: "{}",
  } as unknown as L1SearchResult;
}

function fakeStore(opts: {
  ftsResults?: Array<{ record_id: string; score: number }>;
  vectorResults?: L1SearchResult[];
  nativeHybrid?: boolean;
  hybridResults?: L1SearchResult[];
}): IMemoryStore {
  return {
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: true,
      nativeHybridSearch: opts.nativeHybrid === true,
      sparseVectors: false,
    }),
    isFtsAvailable: () => true,
    searchL1Fts: async () =>
      (opts.ftsResults ?? []).map((r) =>
        l1Result(r.record_id, r.score),
      ),
    searchL1Vector: async () => opts.vectorResults ?? [],
    ...(opts.nativeHybrid ? { searchL1Hybrid: async () => opts.hybridResults ?? [] } : {}),
  } as unknown as IMemoryStore;
}

function fakeEmbedder(): EmbeddingService {
  return {
    getProviderInfo: () => ({ provider: "fake-test" }),
    embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
  } as unknown as EmbeddingService;
}

describe("recall.scoreThreshold per-strategy semantics (#1296)", () => {
  it("hybrid: fused RRF results are NOT filtered by the 0–1 threshold", async () => {
    // All fused RRF scores are ~0.02–0.05, far below the default 0.3 —
    // if the threshold were (wrongly) applied post-fusion, everything
    // would be filtered and hybrid recall would always return empty.
    const store = fakeStore({
      ftsResults: [
        { record_id: "m_fts_1", score: 0.9 }, // would pass a 0–1 threshold
        { record_id: "m_fts_2", score: 0.02 }, // would fail it
      ],
      vectorResults: [l1Result("m_vec_1", 0.8)],
    });
    const res = await searchMemories(
      "口令相关的问题",
      "/tmp/unused",
      cfg,
      undefined,
      "hybrid",
      store,
      fakeEmbedder(),
    );
    // 3 distinct records survive the fusion, none dropped by any threshold
    expect(res.lines.length).toBe(3);
  });

  it("hybrid: debug output exposes the top fused score and the no-threshold decision", async () => {
    const { logger, debugLines } = makeLogger();
    const store = fakeStore({
      ftsResults: [{ record_id: "m_fts_1", score: 0.9 }],
      vectorResults: [l1Result("m_vec_1", 0.8)],
    });
    await searchMemories("口令相关的问题", "/tmp/unused", cfg, logger, "hybrid", store, fakeEmbedder());
    const hybridLog = debugLines.find((s) => s.includes("Hybrid search found"));
    expect(hybridLog).toBeDefined();
    expect(hybridLog).toMatch(/topRrfScore=/);
    expect(hybridLog).toMatch(/threshold not applied/);
  });

  it("native hybrid: server-side RRF rankings are returned without threshold filtering", async () => {
    const store = fakeStore({
      nativeHybrid: true,
      hybridResults: [l1Result("m_native_1", 0.0166), l1Result("m_native_2", 0.0328)],
    });
    const res = await searchMemories(
      "口令相关的问题",
      "/tmp/unused",
      cfg,
      undefined,
      "hybrid",
      store,
    );
    expect(res.lines.length).toBe(2);
  });

  it("keyword: the threshold still applies to the 0–1 BM25-mapped score", async () => {
    const store = fakeStore({
      ftsResults: [
        { record_id: "m_keep", score: 0.9 },
        { record_id: "m_drop", score: 0.2 },
      ],
    });
    const res = await searchMemories(
      "口令相关的问题",
      "/tmp/unused",
      cfg,
      undefined,
      "keyword",
      store,
    );
    expect(res.lines.length).toBe(1);
    expect(res.lines[0]).toContain("m_keep");
  });

  it("embedding: the threshold still applies to the 0–1 cosine score", async () => {
    const store = fakeStore({
      vectorResults: [l1Result("m_keep", 0.85), l1Result("m_drop", 0.1)],
    });
    const res = await searchMemories(
      "口令相关的问题",
      "/tmp/unused",
      cfg,
      undefined,
      "embedding",
      store,
      fakeEmbedder(),
    );
    expect(res.lines.length).toBe(1);
    expect(res.lines[0]).toContain("m_keep");
  });
});
