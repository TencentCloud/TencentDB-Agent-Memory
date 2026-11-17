/**
 * getStore() in-flight dedupe: two concurrent first calls for the same
 * instance must share ONE create+init — previously the second caller
 * either got the cached (still un-initialized) store or built a second
 * store that was never closed when the later pool.set won.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ctorCalls: 0,
  initCalls: 0,
  initImpl: undefined as undefined | (() => Promise<void>),
}));

vi.mock("./sqlite/memory-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite/memory-store.js")>();
  return {
    ...actual,
    VectorStore: class {
      constructor(..._args: unknown[]) {
        h.ctorCalls += 1;
      }
      init() {
        h.initCalls += 1;
        return h.initImpl ? h.initImpl() : Promise.resolve();
      }
      async close() {}
    },
  };
});

vi.mock("./bm25-local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bm25-local.js")>();
  return { ...actual, createBM25Encoder: () => undefined };
});

import { StorePool } from "./store-pool.js";
import type { Logger } from "../types.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function makePool(): StorePool {
  return new StorePool({
    mode: "sqlite",
    memoryCfg: { embedding: { enabled: false } } as never,
    dataDir: "/tmp/store-pool-dedupe-test",
    logger,
  });
}

describe("StorePool.getStore in-flight dedupe", () => {
  beforeEach(() => {
    h.ctorCalls = 0;
    h.initCalls = 0;
    h.initImpl = undefined;
  });

  it("two concurrent first calls build exactly one store, resolved after init", async () => {
    const pool = makePool();
    let releaseInit: (() => void) | undefined;
    h.initImpl = () =>
      new Promise<void>((resolve) => {
        releaseInit = resolve;
      });

    const p1 = pool.getStore("inst-x", null);
    const p2 = pool.getStore("inst-x", null);
    expect(h.ctorCalls).toBe(1);

    let p2resolved = false;
    void p2.then(() => {
      p2resolved = true;
    });
    await new Promise((r) => setImmediate(r));
    // p2 must wait for the in-flight init — not receive the
    // half-initialized store that is already visible in the pool.
    expect(p2resolved).toBe(false);

    releaseInit?.();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(h.initCalls).toBe(1);
  });

  it("a call landing after init hits the pool cache without rebuilding", async () => {
    const pool = makePool();
    const s1 = await pool.getStore("inst-x", null);
    const s2 = await pool.getStore("inst-x", null);
    expect(s1).toBe(s2);
    expect(h.ctorCalls).toBe(1);
    expect(h.initCalls).toBe(1);
  });
});
