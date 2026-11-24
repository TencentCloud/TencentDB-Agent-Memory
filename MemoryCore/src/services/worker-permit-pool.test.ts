import { describe, expect, it } from "vitest";
import { WorkerPermitPool } from "./worker-permit-pool.js";

describe("WorkerPermitPool", () => {
  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid capacity %s", (capacity) => {
    expect(() => new WorkerPermitPool(capacity)).toThrow("positive integer");
  });

  it("keeps the hard capacity limit and transfers permits to waiters in FIFO order", async () => {
    const pool = new WorkerPermitPool(2);
    await Promise.all([pool.acquire(), pool.acquire()]);
    const acquired: string[] = [];
    const first = pool.acquire().then(() => acquired.push("first"));
    const second = pool.acquire().then(() => acquired.push("second"));
    await Promise.resolve();
    expect(acquired).toEqual([]);
    expect([pool.inFlight(), pool.available(), pool.waiting()]).toEqual([2, 0, 2]);

    pool.release();
    await first;
    expect(acquired).toEqual(["first"]);
    expect([pool.inFlight(), pool.available(), pool.waiting()]).toEqual([2, 0, 1]);
    pool.release();
    await second;
    expect(acquired).toEqual(["first", "second"]);
    pool.release();
    pool.release();
    expect([pool.inFlight(), pool.available(), pool.waiting()]).toEqual([0, 2, 0]);
  });

  it("rejects unbalanced releases without corrupting its counters", async () => {
    const pool = new WorkerPermitPool(1);
    expect(() => pool.release()).toThrow("unbalanced");
    await pool.acquire();
    pool.release();
    expect(() => pool.release()).toThrow("unbalanced");
    expect(pool.inFlight()).toBe(0);
  });

  it("rejects all pending and future acquires on shutdown while holders can finish", async () => {
    const pool = new WorkerPermitPool(1);
    await pool.acquire();
    const pending = [pool.acquire(), pool.acquire()];
    const settlements = Promise.allSettled(pending);
    pool.destroy();
    pool.destroy();
    const results = await settlements;
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("destroyed") }) },
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("destroyed") }) },
    ]);
    await expect(pool.acquire()).rejects.toThrow("destroyed");
    expect(pool.waiting()).toBe(0);
    expect(pool.inFlight()).toBe(1);
    pool.release();
    expect(pool.inFlight()).toBe(0);
  });
});
