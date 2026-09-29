import { describe, expect, it, vi } from "vitest";

import { createCodeGraphInstancePool, createCodeGraphInstanceReleaser } from "./module.js";
import { CodeGraphHandleCloseError, type CodeGraphInstance } from "./engines/code/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function instance(name: string): CodeGraphInstance {
  return { projectRoot: name, cg: {}, handler: {} };
}

describe("CodeGraph instance pool lifecycle gate", () => {
  it("blocks new queries and lazy loads while pause waits for a query lease", async () => {
    const openIndex = vi.fn(async () => instance("unexpected"));
    const pool = createCodeGraphInstancePool({ openIndex, closeIndex: vi.fn() });
    const old = instance("old");
    pool.set("graph", old);

    const lease = pool.acquire("graph");
    expect(lease?.instance).toBe(old);
    const paused = pool.pause("graph");
    let drained = false;
    void paused.then(() => { drained = true; });

    expect(pool.acquire("graph")).toBeUndefined();
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();
    expect(openIndex).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(drained).toBe(false);

    lease?.release();
    lease?.release(); // Releasing twice must not let another active query through.
    await paused;
    expect(drained).toBe(true);
    pool.set("graph", instance("new"));
    expect(pool.acquire("graph")).toBeUndefined();
    pool.resume("graph");
    const newLease = pool.acquire("graph");
    expect(newLease?.instance.projectRoot).toBe("new");
    newLease?.release();
  });

  it("waits for an in-flight lazy open and closes its handle when pause wins", async () => {
    const opening = deferred<CodeGraphInstance>();
    const fresh = instance("fresh");
    const openIndex = vi.fn()
      .mockImplementationOnce(() => opening.promise)
      .mockResolvedValue(fresh);
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex, closeIndex });

    const first = pool.loadIfMissing("graph", "/old");
    const second = pool.loadIfMissing("graph", "/old");
    expect(openIndex).toHaveBeenCalledTimes(1);
    const paused = pool.pause("graph");
    let drained = false;
    void paused.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();

    const obsolete = instance("obsolete");
    opening.resolve(obsolete);
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    await paused;
    expect(closeIndex).toHaveBeenCalledExactlyOnceWith(obsolete);
    expect(pool.get("graph")).toBeUndefined();

    pool.resume("graph");
    expect(await pool.loadIfMissing("graph", "/fresh")).toBe(fresh);
    expect(pool.get("graph")).toBe(fresh);
    expect(openIndex).toHaveBeenCalledTimes(2);
  });

  it("does not replace a handle installed while lazy open is pending", async () => {
    const opening = deferred<CodeGraphInstance>();
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex: vi.fn(() => opening.promise), closeIndex });
    const pending = pool.loadIfMissing("graph", "/old");
    const promoted = instance("promoted");
    pool.set("graph", promoted);

    const obsolete = instance("obsolete");
    opening.resolve(obsolete);
    expect(await pending).toBe(promoted);
    expect(pool.get("graph")).toBe(promoted);
    expect(closeIndex).toHaveBeenCalledExactlyOnceWith(obsolete);
  });

  it("rejects pause if a discarded lazy handle cannot be closed", async () => {
    const opening = deferred<CodeGraphInstance>();
    const closeError = new Error("SQLite handle is still open");
    const pool = createCodeGraphInstancePool({
      openIndex: vi.fn(() => opening.promise),
      closeIndex: vi.fn(() => { throw closeError; }),
    });
    const loading = pool.loadIfMissing("graph", "/old");
    const paused = pool.pause("graph");
    opening.resolve(instance("obsolete"));

    const outcomes = await Promise.allSettled([loading, paused]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: closeError },
      { status: "rejected", reason: closeError },
    ]);
    expect(pool.get("graph")).toBeUndefined();
  });

  it("retries a discarded handle close on the next pause after one transient failure", async () => {
    const opening = deferred<CodeGraphInstance>();
    const discarded = instance("discarded");
    const closeIndex = vi.fn()
      .mockImplementationOnce(() => { throw new Error("transient close failure"); })
      .mockImplementation(() => {});
    const pool = createCodeGraphInstancePool({
      openIndex: vi.fn(() => opening.promise), closeIndex,
    });

    const loading = pool.loadIfMissing("graph", "/old");
    const firstPause = pool.pause("graph");
    opening.resolve(discarded);
    const results = await Promise.allSettled([loading, firstPause]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    pool.resume("graph");

    await expect(pool.pause("graph")).resolves.toBeUndefined();
    expect(closeIndex).toHaveBeenCalledTimes(2);
    expect(closeIndex).toHaveBeenNthCalledWith(2, discarded);
    pool.resume("graph");
  });

  it("retains a partially opened lazy handle until deletion can close it", async () => {
    const unclosed = instance("/old");
    const openError = new CodeGraphHandleCloseError(
      "open", new Error("handler failed"), new Error("first close failed"), unclosed.cg, "/old",
    );
    const close = vi.fn()
      .mockImplementationOnce(() => { throw new Error("SQLite still busy"); })
      .mockImplementation(() => {});
    const pool = createCodeGraphInstancePool({
      openIndex: vi.fn().mockRejectedValue(openError), closeIndex: close,
    });
    const releaseInstance = createCodeGraphInstanceReleaser(pool, close);

    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();
    await expect(releaseInstance("graph")).rejects.toBe(openError);
    await expect(releaseInstance("graph")).rejects.toThrow("SQLite still busy");
    const resume = await releaseInstance("graph");
    expect(close).toHaveBeenCalledTimes(2);
    expect(resume).not.toBeNull();
    resume?.();
  });

  it("rejects deletion immediately while a query lease is active, then holds the gate", async () => {
    const old = instance("old");
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex: vi.fn(async () => old), closeIndex });
    pool.set("graph", old);
    const lease = pool.acquire("graph")!;
    const releaseInstance = createCodeGraphInstanceReleaser(pool, closeIndex);
    expect(await releaseInstance("graph")).toBeNull();
    expect(closeIndex).not.toHaveBeenCalled();

    lease.release();
    const resume = await releaseInstance("graph");
    expect(resume).not.toBeNull();
    expect(closeIndex).toHaveBeenCalledExactlyOnceWith(old);
    expect(pool.get("graph")).toBeUndefined();
    expect(pool.acquire("graph")).toBeUndefined();
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();
    resume?.();
    resume?.();
  });

  it("retains a failed-close handle and retries closing it before deletion", async () => {
    const old = instance("old");
    const closeError = new Error("SQLite close failed");
    const pool = createCodeGraphInstancePool({ openIndex: vi.fn(async () => old), closeIndex: vi.fn() });
    pool.set("graph", old);
    const close = vi.fn().mockImplementationOnce(() => { throw closeError; });
    const releaseInstance = createCodeGraphInstanceReleaser(pool, close);

    await expect(releaseInstance("graph")).rejects.toBe(closeError);
    expect(pool.get("graph")).toBe(old);

    const resume = await releaseInstance("graph");
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenNthCalledWith(2, old);
    expect(pool.get("graph")).toBeUndefined();
    resume?.();
  });
});
