import { describe, expect, it, vi } from "vitest";

import {
  createCodeGraphInstancePool,
  type CodeGraphInstancePoolOptions,
} from "./code-graph-instance-pool.js";
import type { CodeGraphInstance } from "./engines/code/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function instance(name: string): CodeGraphInstance {
  return { name } as unknown as CodeGraphInstance;
}

function createPool(
  loadIndex: CodeGraphInstancePoolOptions["loadIndex"],
  closeIndex = vi.fn<CodeGraphInstancePoolOptions["closeIndex"]>(),
) {
  return {
    closeIndex,
    pool: createCodeGraphInstancePool({ loadIndex, closeIndex }),
  };
}

describe("createCodeGraphInstancePool", () => {
  it("shares one lazy load across concurrent callers", async () => {
    const loading = deferred<CodeGraphInstance>();
    const loadIndex = vi.fn(() => loading.promise);
    const { pool } = createPool(loadIndex);

    const first = pool.loadIfMissing("graph-1", "/data/graph-1");
    const second = pool.loadIfMissing("graph-1", "/data/graph-1");

    await Promise.resolve();
    expect(loadIndex).toHaveBeenCalledTimes(1);
    const loaded = instance("shared");
    loading.resolve(loaded);

    await expect(first).resolves.toBe(loaded);
    await expect(second).resolves.toBe(loaded);
    expect(pool.get("graph-1")).toBe(loaded);
  });

  it("does not repopulate the pool when an in-flight load is deleted", async () => {
    const staleLoading = deferred<CodeGraphInstance>();
    const freshLoading = deferred<CodeGraphInstance>();
    const loadIndex = vi
      .fn<CodeGraphInstancePoolOptions["loadIndex"]>()
      .mockImplementationOnce(() => staleLoading.promise)
      .mockImplementationOnce(() => freshLoading.promise);
    const { pool, closeIndex } = createPool(loadIndex);

    const staleRequest = pool.loadIfMissing("graph-1", "/data/graph-1");
    pool.delete("graph-1");
    const freshRequest = pool.loadIfMissing("graph-1", "/data/graph-1");

    const stale = instance("stale");
    staleLoading.resolve(stale);
    await expect(staleRequest).resolves.toBeUndefined();
    expect(closeIndex).toHaveBeenCalledWith(stale);
    expect(pool.get("graph-1")).toBeUndefined();

    const fresh = instance("fresh");
    freshLoading.resolve(fresh);
    await expect(freshRequest).resolves.toBe(fresh);
    expect(pool.get("graph-1")).toBe(fresh);
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it("clears a failed load so a later request can retry", async () => {
    const loaded = instance("retry");
    const loadIndex = vi
      .fn<CodeGraphInstancePoolOptions["loadIndex"]>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce(loaded);
    const { pool } = createPool(loadIndex);

    await expect(
      pool.loadIfMissing("graph-1", "/data/graph-1"),
    ).resolves.toBeUndefined();
    await expect(
      pool.loadIfMissing("graph-1", "/data/graph-1"),
    ).resolves.toBe(loaded);
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it("clears a synchronous load failure so a later request can retry", async () => {
    const loaded = instance("retry");
    const loadIndex = vi
      .fn<CodeGraphInstancePoolOptions["loadIndex"]>()
      .mockImplementationOnce(() => {
        throw new Error("invalid index path");
      })
      .mockResolvedValueOnce(loaded);
    const { pool } = createPool(loadIndex);

    await expect(
      pool.loadIfMissing("graph-1", "/data/graph-1"),
    ).resolves.toBeUndefined();
    await expect(
      pool.loadIfMissing("graph-1", "/data/graph-1"),
    ).resolves.toBe(loaded);
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });
});
