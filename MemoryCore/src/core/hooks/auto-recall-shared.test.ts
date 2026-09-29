import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { performAutoRecall } from "./auto-recall.js";
import { executeMemorySearch } from "../tools/memory-search.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";
import { NoopEmbeddingService, OpenAIEmbeddingService, type EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";

const hit = (id: string, score = 0.1): L1SearchResult => ({
  record_id: id, content: `memory ${id}`, type: "episodic", priority: 1,
  scene_name: "", score, timestamp_str: "2026-09-01", timestamp_start: "",
  timestamp_end: "", version: 1, session_key: "session", session_id: "session",
  metadata_json: JSON.stringify({ activity_start_time: "2026-09-01", activity_end_time: "2026-09-02" }),
});
const store = () => ({
  getCapabilities: vi.fn(() => ({ nativeHybridSearch: false })),
  isFtsAvailable: vi.fn(() => true),
  searchL1Fts: vi.fn().mockResolvedValue([hit("fts"), hit("both")]),
  searchL1Vector: vi.fn().mockResolvedValue([hit("vector", 0.9), hit("both", 0.8)]),
  searchL1Hybrid: vi.fn().mockResolvedValue([hit("native", 0.75)]),
});
const embedder = () => ({ embed: vi.fn().mockResolvedValue(new Float32Array([1, 0])), getProviderInfo: () => ({ provider: "test", model: "test" }) }) as unknown as EmbeddingService;
const cfg = () => {
  const config = parseConfig({});
  config.recall = { ...config.recall, strategy: "hybrid", maxResults: 3, scoreThreshold: 0.99, timeoutMs: 5000 };
  config.embedding.recallTimeoutMs = 30;
  return config;
};
const auto = (s: ReturnType<typeof store>, embeddingService?: EmbeddingService, config = cfg()) => performAutoRecall({
  userText: "memory query", actorId: "test", sessionKey: "session", cfg: config,
  pluginDataDir: process.cwd(), vectorStore: s as unknown as IMemoryStore, embeddingService,
});
const tool = (s: ReturnType<typeof store>, embeddingService?: EmbeddingService) => executeMemorySearch({ query: "memory query", limit: 3, vectorStore: s as unknown as IMemoryStore, embeddingService });
const names = (result: Awaited<ReturnType<typeof auto>>) => result?.recalledL1Memories?.map(r => r.content);

describe("auto-recall and memory_search shared candidates", () => {
  it("uses identical RRF ordering while keeping budgets, formatting and caller scores", async () => {
    const s = store(); const e = embedder();
    const recalled = await auto(s, e); const searched = await tool(s, e);
    expect(names(recalled)).toEqual(searched.results.map(r => r.content));
    expect(searched.results.map(r => r.id)).toEqual(["both", "fts", "vector"]);
    expect(searched.results[0].score).toBeCloseTo(2 / 62);
    expect(recalled?.recalledL1Memories?.map(r => r.score)).toEqual([0, 0, 0]);
    expect(recalled?.prependContext).toContain("2026-09-01 ~ 2026-09-02");
    expect(s.searchL1Fts.mock.calls.map(c => c[1])).toEqual([9, 9]);
    expect(s.searchL1Vector.mock.calls.map(c => c[1])).toEqual([9, 9]);
    expect(e.embed).toHaveBeenNthCalledWith(1, "memory query", { timeoutMs: 30 });
    expect(e.embed).toHaveBeenNthCalledWith(2, "memory query");
  });
  it.each(["fts", "vector"])("retains the surviving branch when %s fails", async failed => {
    const s = store(); const e = embedder();
    (failed === "fts" ? s.searchL1Fts : s.searchL1Vector).mockRejectedValue(new Error("unavailable"));
    const recalled = await auto(s, e); const searched = await tool(s, e);
    expect(names(recalled)).toEqual(searched.results.map(r => r.content));
    expect(searched.results.map(r => r.id)).toEqual(failed === "fts" ? ["vector", "both"] : ["fts", "both"]);
    expect(searched.results[0].score).toBe(failed === "fts" ? 0.9 : 0.1);
    expect(recalled?.error).toBeUndefined();
  });
  it("skips vector-store calls on empty embeddings in both entry points", async () => {
    const s = store(); const e = embedder(); vi.mocked(e.embed).mockResolvedValue(new Float32Array());
    const recalled = await auto(s, e); const searched = await tool(s, e);
    expect(names(recalled)).toEqual(searched.results.map(r => r.content));
    expect(s.searchL1Vector).not.toHaveBeenCalled();
  });
  it("runs native hybrid without client embeddings and preserves service scores", async () => {
    const s = store(); s.getCapabilities.mockReturnValue({ nativeHybridSearch: true }); s.isFtsAvailable.mockReturnValue(false);
    const e = new NoopEmbeddingService(); const spy = vi.spyOn(e, "embed");
    const recalled = await auto(s, e); const searched = await tool(s, e);
    expect(names(recalled)).toEqual(["memory native"]);
    expect(recalled?.recalledL1Memories?.[0].score).toBe(0.75); expect(searched.results[0].score).toBe(0.75);
    expect(s.searchL1Hybrid.mock.calls).toEqual([[{ query: "memory query", topK: 3 }], [{ query: "memory query", topK: 9 }]]);
    expect(spy).not.toHaveBeenCalled(); expect(s.searchL1Fts).not.toHaveBeenCalled(); expect(s.searchL1Vector).not.toHaveBeenCalled();
  });
  it("keeps auto-recall's keyword threshold fallback without embeddings", async () => {
    const s = store(); s.searchL1Fts.mockResolvedValue([hit("a"), hit("b"), hit("c"), hit("d")]);
    expect(await auto(s)).toBeUndefined(); expect((await tool(s)).results.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(s.searchL1Fts.mock.calls.map(c => c[1])).toEqual([6, 9]); expect(s.searchL1Vector).not.toHaveBeenCalled();
  });
  it("returns no memories when both local branches fail", async () => {
    const s = store(); s.searchL1Fts.mockRejectedValue(new Error("fts")); s.searchL1Vector.mockRejectedValue(new Error("vector"));
    expect(await auto(s, embedder())).toBeUndefined(); expect((await tool(s, embedder())).results).toEqual([]);
  });
  it("reports per-branch hit counts and timing", async () => {
    const s = store(); const result = await recallL1Candidates({ query: "memory query", topK: 9, vectorStore: s as unknown as IMemoryStore, embeddingService: embedder() });
    expect(result.timing.ftsHits).toBe(2); expect(result.timing.embeddingHits).toBe(2);
    expect(result.timing.ftsMs).toBeGreaterThanOrEqual(0); expect(result.timing.embeddingMs).toBeGreaterThanOrEqual(0);
  });
  it("uses global embedding timeout when no recall override exists", async () => {
    const s = store(); const e = embedder(); const config = cfg(); config.embedding.recallTimeoutMs = undefined; config.embedding.timeoutMs = 70;
    await auto(s, e, config); expect(e.embed).toHaveBeenCalledWith("memory query", { timeoutMs: 70 });
  });
  it("retains FTS after real HTTP embedding requests time out", async () => {
    let requests = 0; const server = createServer(() => { requests++; });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing loopback port");
    const e = new OpenAIEmbeddingService({ provider: "openai", model: "test", apiKey: "test", dimensions: 2, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 10000 });
    const spy = vi.spyOn(e, "embed"); const s = store();
    try {
      const recalled = await auto(s, e);
      expect(names(recalled)).toEqual(["memory fts", "memory both"]); expect(recalled?.error).toBeUndefined();
      expect(spy).toHaveBeenCalledWith("memory query", { timeoutMs: 30 }); expect(requests).toBe(1); expect(s.searchL1Vector).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});
