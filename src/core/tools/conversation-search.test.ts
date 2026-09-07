import { describe, expect, it, vi } from "vitest";
import { executeConversationSearch } from "./conversation-search.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L0SearchResult } from "../store/types.js";

type L0SearchFilter = { sessionKey?: string };

function l0Result(id: string, sessionKey: string): L0SearchResult {
  return {
    record_id: id,
    session_key: sessionKey,
    session_id: "",
    role: "user",
    message_text: `message ${id}`,
    score: 0.9,
    recorded_at: "2026-06-24T00:00:00.000Z",
    timestamp: 0,
  };
}

describe("executeConversationSearch", () => {
  it("pushes the session filter down to FTS search before candidate limiting", async () => {
    const searchL0Fts = vi.fn(
      (_query: string, _limit?: number, filter?: L0SearchFilter): L0SearchResult[] => {
        if (filter?.sessionKey === "session-a") {
          return [l0Result("target", "session-a")];
        }
        return [
          l0Result("other-1", "session-b"),
          l0Result("other-2", "session-b"),
          l0Result("other-3", "session-b"),
          l0Result("other-4", "session-b"),
        ];
      },
    );

    const store = {
      isFtsAvailable: () => true,
      searchL0Fts,
    } as unknown as IMemoryStore;

    const result = await executeConversationSearch({
      query: "target",
      limit: 1,
      sessionKey: "session-a",
      vectorStore: store,
    });

    expect(searchL0Fts).toHaveBeenCalledWith(expect.any(String), 4, { sessionKey: "session-a" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("target");
  });

  it("pushes the session filter down to vector search before candidate limiting", async () => {
    const searchL0Vector = vi.fn(
      (_embedding: Float32Array, _limit?: number, _query?: string, filter?: L0SearchFilter): L0SearchResult[] => {
        if (filter?.sessionKey === "session-a") {
          return [l0Result("target", "session-a")];
        }
        return [
          l0Result("other-1", "session-b"),
          l0Result("other-2", "session-b"),
          l0Result("other-3", "session-b"),
          l0Result("other-4", "session-b"),
        ];
      },
    );

    const store = {
      isFtsAvailable: () => false,
      searchL0Vector,
    } as unknown as IMemoryStore;
    const embeddingService = {
      embed: vi.fn(async () => new Float32Array([1, 0])),
    } as unknown as EmbeddingService;

    const result = await executeConversationSearch({
      query: "target",
      limit: 1,
      sessionKey: "session-a",
      vectorStore: store,
      embeddingService,
    });

    expect(searchL0Vector).toHaveBeenCalledWith(expect.any(Float32Array), 4, "target", { sessionKey: "session-a" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("target");
  });
});
