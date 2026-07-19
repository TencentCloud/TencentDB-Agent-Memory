import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import { createStoreBundle } from "./factory.js";

const createEmbeddingServiceMock = vi.hoisted(() => vi.fn(() => ({
  embed: vi.fn(),
  embedBatch: vi.fn(),
  getDimensions: vi.fn(() => 1024),
  getProviderInfo: vi.fn(() => ({ provider: "qclaw", model: "bge-m3" })),
  isReady: vi.fn(() => true),
  startWarmup: vi.fn(),
})));

const VectorStoreMock = vi.hoisted(() => vi.fn(function VectorStore() {
  return {
    init: vi.fn(),
    isDegraded: vi.fn(() => false),
    getCapabilities: vi.fn(),
    close: vi.fn(),
    reindexAll: vi.fn(),
  };
}));

vi.mock("./embedding.js", () => ({
  createEmbeddingService: createEmbeddingServiceMock,
  NoopEmbeddingService: class NoopEmbeddingService {},
}));

vi.mock("./sqlite.js", () => ({
  VectorStore: VectorStoreMock,
}));

vi.mock("./tcvdb.js", () => ({
  TcvdbMemoryStore: vi.fn(),
}));

vi.mock("./bm25-local.js", () => ({
  createBM25Encoder: vi.fn(() => undefined),
}));

describe("createStoreBundle", () => {
  it("forwards qclaw proxy and timeout embedding config to the remote embedding service", () => {
    const cfg = parseConfig({
      embedding: {
        provider: "qclaw",
        proxyUrl: "http://127.0.0.1:18080/embedding-proxy",
        baseUrl: "https://embedding.example/v1",
        apiKey: "test-key",
        model: "bge-m3",
        dimensions: 1024,
        sendDimensions: false,
        maxInputChars: 4096,
        timeoutMs: 25_000,
      },
    });

    createStoreBundle(cfg, { dataDir: "/tmp/memory-tdai-test" });

    expect(createEmbeddingServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "qclaw",
        proxyUrl: "http://127.0.0.1:18080/embedding-proxy",
        baseUrl: "https://embedding.example/v1",
        timeoutMs: 25_000,
        sendDimensions: false,
        maxInputChars: 4096,
      }),
      undefined,
    );
  });
});
