/**
 * Tests for StorePool.getStore's failed-init handling (#1433).
 *
 * The pool used to register the entry BEFORE init and swallow init errors,
 * so one transient DB outage at first contact cached a broken store forever
 * (the cache-hit path never re-runs init). Now the failed entry is closed,
 * dropped and the error rethrown — the next getStore() re-creates it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorePool } from "./store-pool.js";
import { NoopEmbeddingService } from "./embedding.js";
import type { MemoryTdaiConfig } from "../../config.js";
import type { Logger } from "../types.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makePool(logger: Logger): StorePool {
  const cfg = { bm25: { enabled: false }, embedding: { enabled: false } } as unknown as MemoryTdaiConfig;
  const dataDir = mkdtempSync(join(tmpdir(), "store-pool-test-"));
  const pool = new StorePool({ mode: "sqlite", memoryCfg: cfg, dataDir, logger });
  const origRm = dataDir;
  (pool as unknown as { __dataDir: string }).__dataDir = origRm;
  return pool;
}

function cleanupPool(pool: StorePool): void {
  const dataDir = (pool as unknown as { __dataDir?: string }).__dataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

describe("StorePool.getStore — failed init must not be cached (#1433)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects, closes the store and drops the entry when init fails", async () => {
    const logger = makeLogger();
    const pool = makePool(logger);
    try {
      const store = {
        init: vi.fn(() => {
          throw new Error("connection refused");
        }),
        close: vi.fn(),
      };
      (pool as unknown as Record<string, unknown>).createSqliteStore = () => ({
        store,
        embedding: new NoopEmbeddingService(),
      });

      await expect(pool.getStore("inst-1")).rejects.toThrow("connection refused");
      expect(store.close).toHaveBeenCalled();
      expect((pool as unknown as { pool: Map<string, unknown> }).pool.size).toBe(0);
    } finally {
      cleanupPool(pool);
    }
  });

  it("re-attempts init on the next getStore after a failure (natural retry)", async () => {
    const logger = makeLogger();
    const pool = makePool(logger);
    try {
      const store = {
        init: vi.fn(() => {
          throw new Error("connection refused");
        }),
        close: vi.fn(),
      };
      (pool as unknown as Record<string, unknown>).createSqliteStore = () => ({
        store,
        embedding: new NoopEmbeddingService(),
      });

      await expect(pool.getStore("inst-1")).rejects.toThrow("connection refused");
      await expect(pool.getStore("inst-1")).rejects.toThrow("connection refused");
      expect(store.init).toHaveBeenCalledTimes(2);
    } finally {
      cleanupPool(pool);
    }
  });

  it("caches and returns the store when init succeeds (existing behavior unchanged)", async () => {
    const logger = makeLogger();
    const pool = makePool(logger);
    try {
      const store = { init: vi.fn(), close: vi.fn(), isDegraded: () => false };
      (pool as unknown as Record<string, unknown>).createSqliteStore = () => ({
        store,
        embedding: new NoopEmbeddingService(),
      });

      const first = await pool.getStore("inst-1");
      const second = await pool.getStore("inst-1");
      expect(first.store).toBe(store);
      expect(second.store).toBe(store);
      expect(store.init).toHaveBeenCalledTimes(1);
    } finally {
      cleanupPool(pool);
    }
  });
});
