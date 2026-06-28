import { describe, expect, it, vi } from "vitest";
import { batchDedup } from "./l1-dedup.js";
import type { LLMRunner } from "../types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore } from "../store/types.js";

describe("batchDedup", () => {
  it("does not override the timeout of a host-neutral LLM runner", async () => {
    const run = vi.fn(async () => JSON.stringify([
      {
        record_id: "new-1",
        action: "store",
        target_ids: [],
      },
    ]));
    const llmRunner = { run } satisfies LLMRunner;
    const embeddingService = {
      embedBatch: vi.fn(async () => [new Float32Array([0.1, 0.2])]),
    } as unknown as EmbeddingService;
    const vectorStore = {
      countL1: vi.fn(async () => 1),
      isFtsAvailable: vi.fn(() => false),
      searchL1Vector: vi.fn(async () => [
        {
          record_id: "existing-1",
          content: "User likes concise TypeScript answers.",
          type: "preference",
          priority: 80,
          scene_name: "preferences",
          score: 0.9,
          timestamp_str: "2026-01-01",
          timestamp_start: "2026-01-01T00:00:00.000Z",
          timestamp_end: "2026-01-01T00:00:00.000Z",
          session_key: "session-1",
          session_id: "session-1",
          metadata_json: "{}",
        },
      ]),
    } as unknown as IMemoryStore;

    await batchDedup({
      memories: [
        {
          record_id: "new-1",
          content: "User prefers concise TypeScript explanations.",
          type: "preference",
          priority: 80,
          source_message_ids: ["m1"],
          metadata: {},
          scene_name: "preferences",
        },
      ],
      config: {},
      vectorStore,
      embeddingService,
      llmRunner,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).not.toHaveProperty("timeoutMs");
  });
});
