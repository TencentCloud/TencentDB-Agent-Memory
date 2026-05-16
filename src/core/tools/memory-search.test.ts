import { describe, expect, it } from "vitest";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1FtsResult, L1SearchResult } from "../store/types.js";
import { executeMemorySearch } from "./memory-search.js";

function l1Result(params: {
  content: string;
  recordId: string;
  sessionId?: string;
  sessionKey: string;
}): L1FtsResult {
  return {
    content: params.content,
    metadata_json: "{}",
    priority: 50,
    record_id: params.recordId,
    scene_name: "review",
    score: 0.9,
    session_id: params.sessionId ?? `${params.sessionKey}:sub`,
    session_key: params.sessionKey,
    timestamp_end: "2026-05-16T00:00:00.000Z",
    timestamp_start: "2026-05-16T00:00:00.000Z",
    timestamp_str: "2026-05-16",
    type: "preference",
  };
}

describe("memory search scope", () => {
  it("filters L1 FTS results by sessionKey before formatting", async () => {
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [
        l1Result({
          content: "Refresh project prefers strict code review.",
          recordId: "refresh-review-style",
          sessionKey: "refresh-project",
        }),
        l1Result({
          content: "Other project prefers loose review.",
          recordId: "other-review-style",
          sessionKey: "other-project",
        }),
      ],
    } as Partial<IMemoryStore> as IMemoryStore;

    const result = await executeMemorySearch({
      limit: 5,
      query: "review style",
      sessionKey: "refresh-project",
      vectorStore,
    });

    expect(result.total).toBe(1);
    expect(result.results.map((item) => item.content)).toEqual([
      "Refresh project prefers strict code review.",
    ]);
  });

  it("passes scope to the L1 store so filtering happens before topK truncation", async () => {
    let observedFilter: { sessionKey?: string; sessionId?: string } | undefined;
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: async (
        _ftsQuery: string,
        _limit?: number,
        filter?: { sessionKey?: string; sessionId?: string },
      ) => {
        observedFilter = filter;
        if (filter?.sessionKey === "refresh-project") {
          return [
            l1Result({
              content: "Refresh project keeps in-scope memory after store filtering.",
              recordId: "refresh-store-scoped",
              sessionKey: "refresh-project",
            }),
          ];
        }
        return Array.from({ length: 20 }, (_, index) =>
          l1Result({
            content: `Other project memory ${index}`,
            recordId: `other-${index}`,
            sessionKey: "other-project",
          }),
        );
      },
    } as Partial<IMemoryStore> as IMemoryStore;

    const result = await executeMemorySearch({
      limit: 5,
      query: "store scoped",
      sessionKey: "refresh-project",
      vectorStore,
    });

    expect(observedFilter).toEqual({ sessionKey: "refresh-project" });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("refresh-store-scoped");
  });

  it("passes scope to vector L1 search before vector topK truncation", async () => {
    let observedFilter: { sessionKey?: string; sessionId?: string } | undefined;
    const vectorStore = {
      isFtsAvailable: () => false,
      searchL1Vector: async (
        _embedding: Float32Array,
        _limit?: number,
        _queryText?: string,
        filter?: { sessionKey?: string; sessionId?: string },
      ): Promise<L1SearchResult[]> => {
        observedFilter = filter;
        return filter?.sessionId === "sub-1"
          ? [
              l1Result({
                content: "Refresh vector memory stays scoped by session id.",
                recordId: "refresh-vector-scoped",
                sessionId: "sub-1",
                sessionKey: "refresh-project",
              }),
            ]
          : [];
      },
    } as Partial<IMemoryStore> as IMemoryStore;
    const embeddingService = {
      embed: async () => new Float32Array([0.1, 0.2]),
    } as Partial<EmbeddingService> as EmbeddingService;

    const result = await executeMemorySearch({
      embeddingService,
      limit: 5,
      query: "vector scoped",
      sessionId: "sub-1",
      vectorStore,
    });

    expect(observedFilter).toEqual({ sessionId: "sub-1" });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("refresh-vector-scoped");
  });
});
