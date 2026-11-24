import { describe, expect, it, vi } from "vitest";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L0SearchResult } from "../store/types.js";
import { executeConversationSearch } from "./conversation-search.js";

function conversation(id: string): L0SearchResult {
  return {
    record_id: id,
    session_key: `key-${id}`,
    session_id: `session-${id}`,
    team_id: "team-1",
    task_id: "task-1",
    user_id: `user-${id}`,
    agent_id: `agent-${id}`,
    role: "user",
    message_text: `Remember the deployment decision from ${id}`,
    score: 0.9,
    recorded_at: "2026-09-11T00:00:00.000Z",
    timestamp: 1789084800000,
  };
}

function expectSource(result: object, row: L0SearchResult): void {
  expect(result).toMatchObject({
    id: row.record_id,
    session_key: row.session_key,
    session_id: row.session_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    role: row.role,
    content: row.message_text,
    recorded_at: row.recorded_at,
  });
}

describe("executeConversationSearch source fields", () => {
  it.each(["fts", "embedding", "hybrid", "native-hybrid"] as const)(
    "preserves each message's source through %s search",
    async (mode) => {
      const rows = [conversation("first"), conversation("second")];
      const searchL0Fts = vi.fn().mockResolvedValue(rows);
      const searchL0Vector = vi.fn().mockResolvedValue(rows);
      const searchL0Hybrid = vi.fn().mockResolvedValue(rows);
      const store = {
        isFtsAvailable: () => mode !== "embedding",
        getCapabilities: () => ({ nativeHybridSearch: mode === "native-hybrid" }),
        searchL0Fts,
        searchL0Vector,
        searchL0Hybrid,
      } as unknown as IMemoryStore;
      const embed = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
      const embeddingService = { embed } as unknown as EmbeddingService;

      const result = await executeConversationSearch({
        query: "deployment decision",
        limit: 2,
        vectorStore: store,
        embeddingService: mode === "embedding" || mode === "hybrid" ? embeddingService : undefined,
      });

      expect(result.strategy).toBe(mode === "native-hybrid" ? "hybrid" : mode);
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
      rows.forEach((row, index) => expectSource(result.results[index], row));
      if (mode === "hybrid") {
        expect(searchL0Fts).toHaveBeenCalledOnce();
        expect(searchL0Vector).toHaveBeenCalledOnce();
        // Both paths return the same records; RRF must merge them without losing their source.
        expect(result.results[0].score).toBeCloseTo(2 / 61);
        expect(result.results[1].score).toBeCloseTo(2 / 62);
      } else {
        expect(result.results[0].score).toBe(rows[0].score);
      }
    },
  );

  it("preserves source fields when embedding fails and search falls back to FTS", async () => {
    const row = conversation("fallback");
    const store = {
      isFtsAvailable: () => true,
      getCapabilities: () => ({ nativeHybridSearch: false }),
      searchL0Fts: vi.fn().mockResolvedValue([row]),
    } as unknown as IMemoryStore;
    const embed = vi.fn().mockRejectedValue(new Error("Embedding provider unavailable"));

    const result = await executeConversationSearch({
      query: "deployment decision",
      limit: 1,
      vectorStore: store,
      embeddingService: { embed } as unknown as EmbeddingService,
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(result.strategy).toBe("fts");
    expect(result.total).toBe(1);
    expectSource(result.results[0], row);
  });
});
