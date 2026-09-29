/**
 * Tests for #678 — createStoreBundle must create an embedding service for
 * provider="local" (offline node-llama-cpp), not only for remote providers
 * with an apiKey.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createEmbeddingService } = vi.hoisted(() => ({
  createEmbeddingService: vi.fn(() => ({ getDimensions: () => 768, startWarmup: vi.fn() })),
}));

vi.mock("./embedding.js", () => ({
  createEmbeddingService,
  NoopEmbeddingService: class {
    getDimensions() {
      return 0;
    }
  },
}));

import { createStoreBundle } from "./factory.js";

function makeConfig(provider: string, enabled: boolean) {
  return {
    storeBackend: "sqlite",
    embedding: {
      enabled,
      provider,
      baseUrl: "",
      apiKey: "",
      model: "",
      dimensions: 768,
      sendDimensions: false,
      maxInputChars: 512,
    },
    bm25: { enabled: true, language: "zh" },
  } as never;
}

describe("createStoreBundle embedding provider (#678)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-factory-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates an embedding service when provider=local (no apiKey needed)", () => {
    createStoreBundle(makeConfig("local", true), { dataDir });

    expect(createEmbeddingService).toHaveBeenCalledTimes(1);
    expect(createEmbeddingService).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "local" }),
      undefined,
    );
  });

  it("skips the embedding service when provider=none", () => {
    createStoreBundle(makeConfig("none", false), { dataDir });

    expect(createEmbeddingService).not.toHaveBeenCalled();
  });
});
