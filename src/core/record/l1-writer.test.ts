import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingCallOptions, EmbeddingProviderInfo, EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore } from "../store/types.js";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory } from "./l1-writer.js";

describe("writeMemory", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("passes capture embedding timeout to vector dual-write embedding calls", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-writer-"));
    tempDirs.push(baseDir);

    let seenOptions: EmbeddingCallOptions | undefined;
    let seenEmbedding: Float32Array | undefined;

    const embeddingService: EmbeddingService = {
      async embed(_text: string, options?: EmbeddingCallOptions): Promise<Float32Array> {
        seenOptions = options;
        return new Float32Array([1, 0]);
      },
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error("not used");
      },
      getDimensions(): number {
        return 2;
      },
      getProviderInfo(): EmbeddingProviderInfo {
        return { provider: "test", model: "fake" };
      },
      isReady(): boolean {
        return true;
      },
      startWarmup(): void {
        // no-op
      },
    };

    const vectorStore = {
      async upsertL1(_record, embedding) {
        seenEmbedding = embedding;
        return true;
      },
    } as Pick<IMemoryStore, "upsertL1"> as IMemoryStore;

    const memory: ExtractedMemory = {
      content: "用户的 CPU embedding 请求需要更长超时",
      type: "episodic",
      priority: 50,
      source_message_ids: ["m1"],
      metadata: {},
      scene_name: "排障",
    };

    const record = await writeMemory({
      memory,
      decision: { record_id: "m_test", action: "store", target_ids: [] },
      baseDir,
      sessionKey: "session-a",
      vectorStore,
      embeddingService,
      embeddingTimeoutMs: 15_000,
    });

    expect(record?.id).toBe("m_test");
    expect(seenOptions).toEqual({ timeoutMs: 15_000 });
    expect(seenEmbedding).toEqual(new Float32Array([1, 0]));
  });
});
