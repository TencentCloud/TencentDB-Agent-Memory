import { describe, expect, it, vi } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";

const state = vi.hoisted(() => ({
  instances: 0,
  initCalls: 0,
  initResults: [] as Array<"ok" | "fail" | "degraded">,
  created: [] as Array<{ markDegraded: () => void }>,
}));

vi.mock("./sqlite/memory-store.js", () => ({
  VectorStore: class {
    private degraded = false;

    constructor() {
      state.instances++;
      state.created.push(this as unknown as { markDegraded: () => void });
    }

    async init() {
      state.initCalls++;
      const result = state.initResults.shift() ?? "ok";
      if (result === "fail") throw new Error("temporary database outage");
      this.degraded = result === "degraded";
      return {};
    }

    isDegraded() {
      return this.degraded;
    }

    isFtsAvailable() {
      return false;
    }

    async close() {}

    markDegraded() {
      this.degraded = true;
    }
  },
}));

const { StorePool } = await import("./store-pool.js");

describe("StorePool initialization", () => {
  it("does not cache a failed init and retries on the next request", async () => {
    state.instances = 0;
    state.initCalls = 0;
    state.initResults = ["fail", "ok"];
    state.created = [];
    const pool = new StorePool({
      mode: "sqlite",
      memoryCfg: {
        bm25: { enabled: false },
        embedding: { enabled: false },
      } as unknown as MemoryTdaiConfig,
      dataDir: ".",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    pool.setGraceCloseDelay(0);

    await expect(pool.getStore("default", null)).rejects.toThrow(
      "temporary database outage",
    );
    expect(pool.has("default")).toBe(false);

    await expect(pool.getStore("default", null)).resolves.toBeDefined();
    expect(pool.has("default")).toBe(true);
    expect(state.instances).toBe(2);
    expect(state.initCalls).toBe(2);
  });

  it("evicts and recreates a cached store after it becomes degraded", async () => {
    state.instances = 0;
    state.initCalls = 0;
    state.initResults = ["ok", "ok"];
    state.created = [];
    const pool = new StorePool({
      mode: "sqlite",
      memoryCfg: {
        bm25: { enabled: false },
        embedding: { enabled: false },
      } as unknown as MemoryTdaiConfig,
      dataDir: ".",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    pool.setGraceCloseDelay(0);

    const first = await pool.getStore("default", null);
    state.created[0]!.markDegraded();
    const second = await pool.getStore("default", null);

    expect(second).not.toBe(first);
    expect(state.instances).toBe(2);
    expect(pool.has("default")).toBe(true);
  });
});
