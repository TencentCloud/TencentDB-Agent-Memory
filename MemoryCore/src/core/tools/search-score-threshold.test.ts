import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MemoryTdaiConfig } from "../../config.js";
import { performAutoRecall } from "../hooks/auto-recall.js";
import type { EmbeddingService } from "../store/embedding.js";
import type {
  IMemoryStore,
  L0FtsResult,
  L0SearchResult,
  L1FtsResult,
  L1SearchResult,
} from "../store/types.js";
import { executeConversationSearch } from "./conversation-search.js";
import { executeMemorySearch } from "./memory-search.js";

const embeddingService = {
  embed: vi.fn(async () => new Float32Array([1, 0])),
} as unknown as EmbeddingService;

function l1Result(record_id: string, score: number): L1SearchResult {
  return {
    record_id,
    content: `memory ${record_id}`,
    type: "fact",
    priority: 1,
    scene_name: "test",
    score,
    timestamp_str: "2026-08-10T00:00:00.000Z",
    timestamp_start: "2026-08-10T00:00:00.000Z",
    timestamp_end: "2026-08-10T00:00:00.000Z",
    version: 1,
    session_key: "session-1",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "task-1",
    user_id: "user-1",
    agent_id: "agent-1",
    metadata_json: "{}",
  };
}

function l0Result(record_id: string, score: number): L0SearchResult {
  return {
    record_id,
    session_key: "session-1",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "task-1",
    user_id: "user-1",
    agent_id: "agent-1",
    role: "user",
    message_text: `message ${record_id}`,
    score,
    recorded_at: "2026-08-10T00:00:00.000Z",
    timestamp: Date.parse("2026-08-10T00:00:00.000Z"),
  };
}

function memoryStore(params: {
  l1Fts?: L1FtsResult[];
  l1Vector?: L1SearchResult[];
  l0Fts?: L0FtsResult[];
  l0Vector?: L0SearchResult[];
}): IMemoryStore {
  return {
    getCapabilities: () => ({ nativeHybridSearch: false }),
    isFtsAvailable: () => Boolean(params.l1Fts || params.l0Fts),
    searchL1Fts: vi.fn(async () => params.l1Fts ?? []),
    searchL1Vector: vi.fn(async () => params.l1Vector ?? []),
    searchL0Fts: vi.fn(async () => params.l0Fts ?? []),
    searchL0Vector: vi.fn(async () => params.l0Vector ?? []),
  } as unknown as IMemoryStore;
}

describe("search score threshold", () => {
  it("filters weak L1 vector candidates before RRF without filtering FTS matches", async () => {
    const store = memoryStore({
      l1Fts: [l1Result("lexical", 0.01)],
      l1Vector: [l1Result("strong-vector", 0.8), l1Result("weak-vector", 0.2)],
    });

    const result = await executeMemorySearch({
      query: "parental leave policy",
      limit: 5,
      vectorStore: store,
      embeddingService,
      scoreThreshold: 0.5,
    });

    expect(result.strategy).toBe("hybrid");
    expect(result.results.map((item) => item.id)).toEqual(
      expect.arrayContaining(["lexical", "strong-vector"]),
    );
    expect(result.results.map((item) => item.id)).not.toContain("weak-vector");
  });

  it("filters weak L0 vector candidates before RRF without filtering FTS matches", async () => {
    const store = memoryStore({
      l0Fts: [l0Result("lexical", 0.01)],
      l0Vector: [l0Result("strong-vector", 0.8), l0Result("weak-vector", 0.2)],
    });

    const result = await executeConversationSearch({
      query: "parental leave policy",
      limit: 5,
      vectorStore: store,
      embeddingService,
      scoreThreshold: 0.5,
    });

    expect(result.strategy).toBe("hybrid");
    expect(result.results.map((item) => item.id)).toEqual(
      expect.arrayContaining(["lexical", "strong-vector"]),
    );
    expect(result.results.map((item) => item.id)).not.toContain("weak-vector");
  });

  it("preserves vector candidates when the optional threshold is omitted", async () => {
    const store = memoryStore({ l1Vector: [l1Result("weak-vector", 0.01)] });

    const result = await executeMemorySearch({
      query: "parental leave policy",
      limit: 5,
      vectorStore: store,
      embeddingService,
    });

    expect(result.results.map((item) => item.id)).toEqual(["weak-vector"]);
  });

  it("applies the threshold to the default hybrid auto-recall vector branch", async () => {
    const store = memoryStore({
      l1Vector: [l1Result("strong-vector", 0.8), l1Result("weak-vector", 0.2)],
    });
    const cfg = {
      recall: {
        enabled: true,
        maxResults: 5,
        maxCharsPerMemory: 0,
        maxTotalRecallChars: 0,
        scoreThreshold: 0.5,
        strategy: "hybrid",
        timeoutMs: 5_000,
      },
      embedding: {},
    } as MemoryTdaiConfig;

    const result = await performAutoRecall({
      userText: "parental leave policy",
      actorId: "user-1",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: join(tmpdir(), "tdai-score-threshold-test-does-not-exist"),
      vectorStore: store,
      embeddingService,
    });

    expect(result?.prependContext).toContain("memory strong-vector");
    expect(result?.prependContext).not.toContain("memory weak-vector");
  });
});
