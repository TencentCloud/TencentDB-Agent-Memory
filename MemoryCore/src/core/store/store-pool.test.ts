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

describe("StorePool.createSqliteStore embedding service", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function buildPool(sendDimensions: boolean): Promise<void> {
    const dataDir = mkdtempSync(path.join(tmpdir(), "store-pool-"));
    dirs.push(dataDir);
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(sendDimensions), dataDir, logger });
    await pool.getStore("tenant-a", null);
  }

  // Regression for #1343: without the forwarded flag, EmbeddingService falls
  // back to `sendDimensions: true` and every embed call fails against an
  // endpoint that rejects an explicit `dimensions` parameter.
  it("forwards sendDimensions:false to the embedding service", async () => {
    await buildPool(false);

    expect(mocks.createEmbeddingService).toHaveBeenCalledTimes(1);
    expect(mocks.createEmbeddingService.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      sendDimensions: false,
    });
  });

  it("forwards sendDimensions:true when the config enables it", async () => {
    await buildPool(true);

    expect(mocks.createEmbeddingService.mock.calls[0]?.[0]).toMatchObject({
      sendDimensions: true,
    });
  });
});
