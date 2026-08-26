/**
 * Regression tests for https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1155
 *
 * initStores() caches the promise returned by _doInitStores() per dataDir.
 * Two lifecycle flaws made that cache permanent in failure scenarios:
 *
 * 1. A failed init (e.g. sqlite busy during a restart race) resolves to a
 *    bundle with vectorStore/embeddingService = undefined — and that failure
 *    bundle stayed cached forever, permanently disabling vector/FTS recall.
 * 2. A store that was closed later (compaction teardown / restart race outside
 *    the gateway_stop reset path) kept being served from the cache, producing
 *    "statement has been finalized" / "database is not open" on every turn.
 *
 * initStores() must not cache failed bundles, and must re-initialize when the
 * cached bundle's store has been closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMemoryStore } from "../core/store/types.js";

const createStoreBundleMock = vi.fn();

vi.mock("../core/store/factory.js", () => ({
  createStoreBundle: (...args: unknown[]) => createStoreBundleMock(...args),
}));

// Keep the manifest side effects (fs) out of these unit tests.
vi.mock("./manifest.js", () => ({
  readManifest: () => undefined,
  writeManifest: () => undefined,
  buildStoreInfo: () => ({}),
  diffStoreBinding: () => [],
}));

import { initStores, resetStores } from "./pipeline-factory.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const cfg = {
  storeBackend: "sqlite",
  embedding: { provider: "none" },
  bm25: {},
} as never;

function makeStore(overrides?: { closed?: boolean }) {
  const state = { closed: overrides?.closed ?? false };
  const store: Partial<IMemoryStore> & { isClosed(): boolean } = {
    init: vi.fn(async () => ({ needsReindex: false })),
    isDegraded: () => false,
    isClosed: () => state.closed,
    close: vi.fn(() => {
      state.closed = true;
    }),
  };
  return store as IMemoryStore & { isClosed(): boolean };
}

function healthyBundle(store: IMemoryStore) {
  return {
    store,
    embedding: undefined,
    bm25Encoder: undefined,
    storeSnapshot: { type: "sqlite" },
  };
}

describe("initStores cache lifecycle", () => {
  beforeEach(() => {
    createStoreBundleMock.mockReset();
    resetStores();
    vi.clearAllMocks();
  });

  it("reuses a healthy cached bundle (single init)", async () => {
    const store = makeStore();
    createStoreBundleMock.mockReturnValue(healthyBundle(store));

    const a = await initStores(cfg, "/data/dir-a", logger);
    const b = await initStores(cfg, "/data/dir-a", logger);

    expect(a.vectorStore).toBe(store);
    expect(b.vectorStore).toBe(store);
    expect(createStoreBundleMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed init bundle — a later call re-initializes", async () => {
    createStoreBundleMock.mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const store = makeStore();
    createStoreBundleMock.mockImplementationOnce(() => healthyBundle(store));

    const failed = await initStores(cfg, "/data/dir-b", logger);
    expect(failed.vectorStore).toBeUndefined();

    const recovered = await initStores(cfg, "/data/dir-b", logger);
    expect(recovered.vectorStore).toBe(store);
    expect(createStoreBundleMock).toHaveBeenCalledTimes(2);
  });

  it("re-initializes when the cached store has been closed", async () => {
    const first = makeStore();
    const second = makeStore();
    createStoreBundleMock
      .mockImplementationOnce(() => healthyBundle(first))
      .mockImplementationOnce(() => healthyBundle(second));

    const a = await initStores(cfg, "/data/dir-c", logger);
    expect(a.vectorStore).toBe(first);

    first.close();

    const b = await initStores(cfg, "/data/dir-c", logger);
    expect(b.vectorStore).toBe(second);
    expect(createStoreBundleMock).toHaveBeenCalledTimes(2);
  });

  it("resetStores(dataDir) still forces re-initialization (existing contract)", async () => {
    const first = makeStore();
    const second = makeStore();
    createStoreBundleMock
      .mockImplementationOnce(() => healthyBundle(first))
      .mockImplementationOnce(() => healthyBundle(second));

    await initStores(cfg, "/data/dir-d", logger);
    resetStores("/data/dir-d");
    const b = await initStores(cfg, "/data/dir-d", logger);

    expect(b.vectorStore).toBe(second);
    expect(createStoreBundleMock).toHaveBeenCalledTimes(2);
  });
});
