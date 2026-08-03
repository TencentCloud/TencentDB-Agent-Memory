import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";

const mocks = vi.hoisted(() => ({
  createStoreBundle: vi.fn(),
}));

vi.mock("../core/store/factory.js", () => ({
  createStoreBundle: mocks.createStoreBundle,
}));

import {
  initStores,
  resetStores,
  type PipelineLogger,
} from "./pipeline-factory.js";

const cfg = {
  storeBackend: "sqlite",
  embedding: { provider: "none" },
} as unknown as MemoryTdaiConfig;

const logger: PipelineLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function store(
  init: IMemoryStore["init"],
  degraded = false,
): IMemoryStore {
  return {
    init,
    isDegraded: () => degraded,
  } as unknown as IMemoryStore;
}

function bundle(vectorStore: IMemoryStore) {
  return {
    store: vectorStore,
    embedding: undefined,
    storeSnapshot: { type: "sqlite", sqlitePath: "vectors.db" },
  };
}

afterEach(() => {
  resetStores();
  mocks.createStoreBundle.mockReset();
  vi.clearAllMocks();
});

describe("initStores cache lifecycle", () => {
  it("retries after a failed initialization result", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "store-init-retry-"));
    const failedStore = store(vi.fn().mockRejectedValue(new Error("offline")));
    const healthyStore = store(
      vi.fn().mockResolvedValue({ needsReindex: false }),
    );
    mocks.createStoreBundle
      .mockReturnValueOnce(bundle(failedStore))
      .mockReturnValueOnce(bundle(healthyStore));

    try {
      const first = initStores(cfg, dataDir, logger);
      const second = initStores(cfg, dataDir, logger);
      expect(first).toBe(second);
      await expect(first).resolves.toMatchObject({
        vectorStore: undefined,
        embeddingService: undefined,
      });
      await expect(second).resolves.toMatchObject({
        vectorStore: undefined,
        embeddingService: undefined,
      });
      expect(mocks.createStoreBundle).toHaveBeenCalledTimes(1);

      await expect(initStores(cfg, dataDir, logger)).resolves.toMatchObject({
        vectorStore: healthyStore,
        needsReindex: false,
      });
      expect(mocks.createStoreBundle).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("still shares one successful initialization across concurrent callers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "store-init-dedupe-"));
    let resolveInit!: (value: { needsReindex: boolean }) => void;
    const initResult = new Promise<{ needsReindex: boolean }>((resolve) => {
      resolveInit = resolve;
    });
    const healthyStore = store(vi.fn(() => initResult));
    mocks.createStoreBundle.mockReturnValue(bundle(healthyStore));

    try {
      const first = initStores(cfg, dataDir, logger);
      const second = initStores(cfg, dataDir, logger);
      expect(first).toBe(second);
      expect(mocks.createStoreBundle).toHaveBeenCalledTimes(1);

      resolveInit({ needsReindex: false });
      await expect(first).resolves.toMatchObject({
        vectorStore: healthyStore,
      });
      await expect(second).resolves.toMatchObject({
        vectorStore: healthyStore,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
