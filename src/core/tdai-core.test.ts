import { describe, expect, it, vi } from "vitest";
import { TdaiCore } from "./tdai-core.js";
import type { HostAdapter, Logger } from "./types.js";
import type { IMemoryStore } from "./store/types.js";
import type { EmbeddingService } from "./store/embedding.js";
import type { MemoryTdaiConfig } from "../config.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeHostAdapter(): HostAdapter {
  return {
    hostType: "standalone",
    getLogger: () => logger,
    getRuntimeContext: () => ({
      userId: "user-1",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      platform: "standalone",
      workspaceDir: "/tmp/workspace",
      dataDir: "/tmp/data",
    }),
    getLLMRunnerFactory: () => ({
      createRunner: () => ({
        run: async () => "",
      }),
    }),
  };
}

function makeEmbeddingService() {
  return {
    embed: vi.fn(async () => new Float32Array([0.1, 0.2])),
  } as unknown as EmbeddingService & {
    embed: ReturnType<typeof vi.fn>;
  };
}

function makeVectorStore() {
  return {
    isFtsAvailable: vi.fn(() => false),
    searchL1Vector: vi.fn(async () => [
      {
        record_id: "memory-1",
        content: "prefers short recall timeouts",
        type: "preference",
        priority: 80,
        scene_name: "global",
        score: 0.91,
        timestamp_str: "2026-01-01",
        timestamp_start: "2026-01-01T00:00:00.000Z",
        timestamp_end: "2026-01-01T00:00:00.000Z",
        session_key: "session-key-1",
        session_id: "session-1",
        metadata_json: "{}",
      },
    ]),
    searchL0Vector: vi.fn(async () => [
      {
        record_id: "turn-1",
        session_key: "session-key-1",
        session_id: "session-1",
        role: "user",
        message_text: "conversation search should use recall timeout",
        score: 0.89,
        recorded_at: "2026-01-01T00:00:00.000Z",
        timestamp: 1767225600000,
      },
    ]),
  } as unknown as IMemoryStore;
}

function makeCore(config: unknown) {
  const core = new TdaiCore({
    hostAdapter: makeHostAdapter(),
    config: config as MemoryTdaiConfig,
  });
  const embeddingService = makeEmbeddingService();
  const vectorStore = makeVectorStore();

  (core as unknown as { embeddingService: EmbeddingService }).embeddingService = embeddingService;
  (core as unknown as { vectorStore: IMemoryStore }).vectorStore = vectorStore;

  return { core, embeddingService };
}

describe("TdaiCore search tools", () => {
  it("uses embedding.recallTimeoutMs for tdai_memory_search embeddings", async () => {
    const { core, embeddingService } = makeCore({
      embedding: {
        timeoutMs: 10_000,
        recallTimeoutMs: 2_000,
      },
    });

    await core.searchMemories({ query: "recall timeout query", limit: 1 });

    expect(embeddingService.embed).toHaveBeenCalledWith(
      "recall timeout query",
      { timeoutMs: 2_000 },
    );
  });

  it("falls back to embedding.timeoutMs for tdai_conversation_search embeddings", async () => {
    const { core, embeddingService } = makeCore({
      embedding: {
        timeoutMs: 7_500,
      },
    });

    await core.searchConversations({ query: "conversation timeout query", limit: 1 });

    expect(embeddingService.embed).toHaveBeenCalledWith(
      "conversation timeout query",
      { timeoutMs: 7_500 },
    );
  });
});
