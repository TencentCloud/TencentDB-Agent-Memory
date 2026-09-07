import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { createPipeline, resetStores } from "./pipeline-factory.js";

const createStoreBundleMock = vi.hoisted(() => vi.fn());

vi.mock("../core/store/factory.js", () => ({
  createStoreBundle: createStoreBundleMock,
}));

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn(async () => new Float32Array([1, 0])),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
    getDimensions: vi.fn(() => 2),
    getProviderInfo: vi.fn(() => ({ provider: "openai", model: "test-embedding" })),
    isReady: vi.fn(() => true),
    startWarmup: vi.fn(),
    close: vi.fn(),
  };
}

function createMemoryStore(): IMemoryStore {
  return {
    init: vi.fn(async () => ({ needsReindex: true, reason: "embedding model changed" })),
    isDegraded: vi.fn(() => false),
    getCapabilities: vi.fn(() => ({
      vectorSearch: true,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    })),
    close: vi.fn(),
    upsertL1: vi.fn(),
    deleteL1: vi.fn(),
    deleteL1Batch: vi.fn(),
    deleteL1Expired: vi.fn(),
    countL1: vi.fn(),
    queryL1Records: vi.fn(),
    getAllL1Texts: vi.fn(),
    searchL1Vector: vi.fn(),
    searchL1Fts: vi.fn(),
    upsertL0: vi.fn(),
    deleteL0: vi.fn(),
    deleteL0Expired: vi.fn(),
    countL0: vi.fn(),
    queryL0ForL1: vi.fn(),
    queryL0GroupedBySessionId: vi.fn(),
    getAllL0Texts: vi.fn(),
    searchL0Vector: vi.fn(),
    searchL0Fts: vi.fn(),
    reindexAll: vi.fn(async (embedFn: (text: string) => Promise<Float32Array>, onProgress) => {
      await embedFn("existing L1 memory");
      onProgress?.(1, 1, "L1");
      return { l1Count: 1, l0Count: 0 };
    }),
    isFtsAvailable: vi.fn(() => true),
  } as unknown as IMemoryStore;
}

describe("createPipeline", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    resetStores();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reindexes existing records when store init reports embedding drift", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pipeline-factory-"));
    const store = createMemoryStore();
    const embeddingService = createEmbeddingService();
    createStoreBundleMock.mockReturnValue({
      store,
      embedding: embeddingService,
      storeSnapshot: { type: "sqlite", sqlitePath: "vectors.db" },
    });

    const cfg = parseConfig({
      embedding: {
        provider: "openai",
        baseUrl: "https://embedding.example/v1",
        apiKey: "test-key",
        model: "test-embedding",
        dimensions: 2,
      },
    });

    const pipeline = await createPipeline({
      pluginDataDir: tempDir,
      cfg,
      openclawConfig: {},
      logger: createLogger(),
    });

    try {
      expect(store.reindexAll).toHaveBeenCalledTimes(1);
      expect(embeddingService.embed).toHaveBeenCalledWith("existing L1 memory");
    } finally {
      await pipeline.destroy();
    }
  });
});
