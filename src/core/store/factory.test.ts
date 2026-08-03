import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the modules that have side effects or require runtime dependencies
vi.mock("../../../utils/manifest.js", () => ({
  writeStoreConfigManifest: vi.fn(),
}));

vi.mock("../../../utils/bm25-local.js", () => ({
  createBM25Encoder: vi.fn().mockReturnValue({
    encodeText: vi.fn(),
    loadCorpus: vi.fn(),
    search: vi.fn(),
    scores: vi.fn(),
    setMode: vi.fn(),
    save: vi.fn(),
    getStats: vi.fn(),
  }),
}));

// We need to mock the embedding.ts module because it tries to load llama-cpp
// We will also mock VectorStore to avoid real file I/O
vi.mock("./embedding.js", () => {
  const LocalMockEmbedding = vi.fn().mockImplementation(() => ({
    provider: "local",
    startWarmup: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue(new Float32Array(768)),
    embedBatch: vi.fn().mockResolvedValue([new Float32Array(768)]),
  }));
  const RemoteMockEmbedding = vi.fn().mockImplementation(() => ({
    provider: "remote",
    startWarmup: vi.fn(),
    embed: vi.fn().mockResolvedValue(new Float32Array(768)),
    embedBatch: vi.fn().mockResolvedValue([new Float32Array(768)]),
  }));
  const NoopMockEmbedding = vi.fn();

  return {
    createEmbeddingService: vi.fn((config: any) => {
      if (config?.provider === "local") return new LocalMockEmbedding();
      if (config?.provider !== "local" && config?.apiKey) return new RemoteMockEmbedding();
      return new LocalMockEmbedding(); // Fallback
    }),
    NoopEmbeddingService: NoopMockEmbedding,
  };
});

vi.mock("./sqlite.js", () => ({
  VectorStore: vi.fn().mockImplementation(() => ({
    insert: vi.fn(),
    insertBatch: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    delete: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    addFtsIndex: vi.fn(),
    searchFts: vi.fn().mockResolvedValue([]),
    getL0Records: vi.fn().mockResolvedValue([]),
  })),
}));

import { createStoreBundle } from "./factory.js";

describe("StoreFactory - Local Embedding Provider (Issue #678)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a local embedding service and call startWarmup() when provider is 'local'", async () => {
    const config = {
      storeBackend: "sqlite",
      embedding: {
        enabled: true,
        provider: "local",
        apiKey: undefined,
        baseUrl: "",
        model: "",
        dimensions: 768,
      },
    } as any;

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = createStoreBundle(config, { dataDir: "/tmp/test-data", logger });

    // Should have created an embedding service
    expect(result.embedding).toBeDefined();
    expect(result.embedding.provider).toBe("local");

    // startWarmup should have been called (fire-and-forget, so we wait a tick)
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.embedding.startWarmup).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Triggering local embedding warmup")
    );
  });

  it("should create a remote embedding service without calling startWarmup when provider is not 'local'", async () => {
    const config = {
      storeBackend: "sqlite",
      embedding: {
        enabled: true,
        provider: "deepseek",
        apiKey: "test-api-key",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        dimensions: 768,
      },
    } as any;

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = createStoreBundle(config, { dataDir: "/tmp/test-data", logger });

    // Should have created an embedding service
    expect(result.embedding).toBeDefined();
    expect(result.embedding.provider).toBe("remote");

    // startWarmup should NOT have been called for remote provider
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.embedding.startWarmup).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Triggering local embedding warmup")
    );
  });
});
