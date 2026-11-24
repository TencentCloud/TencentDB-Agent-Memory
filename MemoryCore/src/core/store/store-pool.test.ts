import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryTdaiConfig } from "../../config.js";

/**
 * These tests pin the one config field that the sqlite (v3 multi-tenant) path
 * must forward to the embedding service. `sendDimensions: false` is the only
 * supported way to talk to endpoints that reject an explicit `dimensions`
 * parameter (BGE-M3, Qwen-embedd, self-hosted gateways, ...); if StorePool drops
 * it, those deployments fail every embed call and silently degrade to
 * keyword-only retrieval.
 */
const mocks = vi.hoisted(() => ({
  createEmbeddingService: vi.fn(() => ({ embed: async () => [] })),
}));

vi.mock("./embedding.js", () => ({
  createEmbeddingService: mocks.createEmbeddingService,
  NoopEmbeddingService: class NoopEmbeddingService {},
}));

vi.mock("./bm25-local.js", () => ({
  createBM25Encoder: () => undefined,
}));

vi.mock("./sqlite/memory-store.js", () => ({
  VectorStore: class VectorStore {
    async init(): Promise<void> {}
    async close(): Promise<void> {}
    async closeAsync(): Promise<void> {}
  },
}));

vi.mock("../report/kafka-metric-producer.js", () => ({
  metricProducer: { initialize: async () => undefined },
}));

import { StorePool } from "./store-pool.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

function memoryCfg(sendDimensions: boolean): MemoryTdaiConfig {
  return {
    bm25: { enabled: false, language: "zh" },
    embedding: {
      enabled: true,
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test-not-a-real-key",
      model: "test-embedding",
      dimensions: 2560,
      sendDimensions,
      maxInputChars: 5000,
    },
  } as unknown as MemoryTdaiConfig;
}

describe("StorePool — sqlite embedding service construction", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "store-pool-test-"));
    mocks.createEmbeddingService.mockClear();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("forwards sendDimensions: false (endpoints that reject `dimensions`)", async () => {
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(false), dataDir, logger });
    await pool.getStore("default", null, null);

    expect(mocks.createEmbeddingService).toHaveBeenCalledTimes(1);
    expect(mocks.createEmbeddingService.mock.calls[0][0]).toMatchObject({
      model: "test-embedding",
      dimensions: 2560,
      sendDimensions: false,
    });
  });

  it("forwards sendDimensions: true", async () => {
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(true), dataDir, logger });
    await pool.getStore("default", null, null);

    expect(mocks.createEmbeddingService).toHaveBeenCalledTimes(1);
    expect(mocks.createEmbeddingService.mock.calls[0][0]).toMatchObject({
      sendDimensions: true,
    });
  });

  it("keeps the rest of the embedding config intact", async () => {
    const pool = new StorePool({ mode: "sqlite", memoryCfg: memoryCfg(false), dataDir, logger });
    await pool.getStore("default", null, null);

    const arg = mocks.createEmbeddingService.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test-not-a-real-key",
      model: "test-embedding",
      dimensions: 2560,
      maxInputChars: 5000,
    });
  });
});
