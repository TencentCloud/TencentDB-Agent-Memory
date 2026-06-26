import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { performAutoCapture } from "./auto-capture.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, StoreCapabilities } from "../store/types.js";

function makeEmbeddingService() {
  const embedding = new Float32Array([1, 0]);
  return {
    embed: vi.fn(async () => embedding),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => embedding)),
    getDimensions: () => 2,
    getProviderInfo: () => ({ provider: "test", model: "test-embedding" }),
    isReady: () => true,
    startWarmup: () => {},
  } satisfies EmbeddingService;
}

function makeVectorStore(supportsDeferredEmbedding: boolean) {
  const capabilities: StoreCapabilities = {
    vectorSearch: true,
    ftsSearch: true,
    nativeHybridSearch: false,
    sparseVectors: false,
  };

  return {
    supportsDeferredEmbedding,
    init: vi.fn(async () => ({ needsReindex: false })),
    isDegraded: () => false,
    getCapabilities: () => capabilities,
    close: vi.fn(),
    upsertL0: vi.fn(async () => true),
    updateL0Embedding: vi.fn(async () => true),
    isFtsAvailable: () => true,
  } as unknown as IMemoryStore;
}

describe("performAutoCapture embedding timeouts", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-auto-capture-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes captureTimeoutMs to synchronous L0 embedding", async () => {
    const cfg = parseConfig({
      embedding: {
        timeoutMs: 10_000,
        captureTimeoutMs: 45_000,
      },
    });
    const embeddingService = makeEmbeddingService();
    const vectorStore = makeVectorStore(false);

    await performAutoCapture({
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Please remember that my local embedding server can be slow during cold starts.",
          timestamp: 1_700_000_000_001,
        },
      ],
      sessionKey: "session-sync",
      cfg,
      pluginDataDir: tmpDir,
      vectorStore,
      embeddingService,
    });

    expect(embeddingService.embed).toHaveBeenCalledWith(
      "Please remember that my local embedding server can be slow during cold starts.",
      { timeoutMs: 45_000 },
    );
  });

  it("passes captureTimeoutMs to deferred background L0 embedding", async () => {
    const cfg = parseConfig({
      embedding: {
        timeoutMs: 10_000,
        captureTimeoutMs: 60_000,
      },
    });
    const embeddingService = makeEmbeddingService();
    const vectorStore = makeVectorStore(true);
    const bgTasks = new Set<Promise<void>>();

    await performAutoCapture({
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Index this conversation with the slower capture embedding timeout.",
          timestamp: 1_700_000_000_002,
        },
      ],
      sessionKey: "session-bg",
      cfg,
      pluginDataDir: tmpDir,
      vectorStore,
      embeddingService,
      bgTaskRegistry: bgTasks,
    });

    await Promise.allSettled([...bgTasks]);

    expect(embeddingService.embedBatch).toHaveBeenCalledWith(
      ["Index this conversation with the slower capture embedding timeout."],
      { timeoutMs: 60_000 },
    );
  });
});
