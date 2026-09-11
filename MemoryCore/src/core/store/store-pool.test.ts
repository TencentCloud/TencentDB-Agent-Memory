import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryTdaiConfig } from "../../config.js";

const mocks = vi.hoisted(() => ({
  createEmbeddingService: vi.fn(() => ({})),
}));

vi.mock("./embedding.js", () => ({
  createEmbeddingService: mocks.createEmbeddingService,
  NoopEmbeddingService: class {},
}));
vi.mock("./bm25-local.js", () => ({ createBM25Encoder: () => undefined }));
vi.mock("./sqlite/memory-store.js", () => ({
  VectorStore: class {
    async close(): Promise<void> {}
  },
}));
vi.mock("../report/kafka-metric-producer.js", () => ({
  metricProducer: { initialize: async () => undefined },
}));

import { StorePool } from "./store-pool.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function memoryCfg(sendDimensions: boolean): MemoryTdaiConfig {
  return {
    bm25: { enabled: false, language: "en" },
    embedding: {
      enabled: true,
      provider: "openai",
      baseUrl: "https://embeddings.example/v1",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 1536,
      sendDimensions,
      maxInputChars: 8000,
    },
  } as unknown as MemoryTdaiConfig;
}

describe("StorePool sqlite embedding service", () => {
  const dirs: string[] = [];

  afterEach(() => {
    mocks.createEmbeddingService.mockClear();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("forwards sendDimensions from the embedding config (#1343)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "store-pool-"));
    dirs.push(dataDir);
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(false), dataDir, logger });

    await pool.getStore("tenant-a", null);

    expect(mocks.createEmbeddingService).toHaveBeenCalledTimes(1);
    expect(mocks.createEmbeddingService.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      sendDimensions: false,
    });
  });

  it("keeps sendDimensions enabled when the config says so", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "store-pool-"));
    dirs.push(dataDir);
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(true), dataDir, logger });

    await pool.getStore("tenant-b", null);

    expect(mocks.createEmbeddingService.mock.calls[0]?.[0]).toMatchObject({ sendDimensions: true });
  });
});
