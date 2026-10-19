import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolTimerQueue, type PoolTimerEntry } from "./timer-queue.js";

function entry(key: string, at: number): PoolTimerEntry {
  return { key, instanceId: "i", accountId: key, kind: "refresh", at };
}

describe("PoolTimerQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires entries in time order with one armed timer", () => {
    const fired: string[] = [];
    const queue = new PoolTimerQueue((e) => fired.push(e.key));
    queue.upsert(entry("b", 2000));
    queue.upsert(entry("a", 1000));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(["a"]);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(["a", "b"]);
  });

  it("replaces an entry with the same key", () => {
    const fired: number[] = [];
    const queue = new PoolTimerQueue((e) => fired.push(e.at));
    queue.upsert(entry("a", 1000));
    queue.upsert(entry("a", 5000));
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual([5000]);
  });

  it("keeps firing when one handler throws", () => {
    const fired: string[] = [];
    const queue = new PoolTimerQueue((e) => {
      fired.push(e.key);
      if (e.key === "a") throw new Error("boom");
    });
    queue.upsert(entry("a", 1000));
    queue.upsert(entry("b", 1000));
    queue.upsert(entry("c", 3000));
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(["a", "b"]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(["a", "b", "c"]);
  });

  it("removes every entry of one account", () => {
    const fired: string[] = [];
    const queue = new PoolTimerQueue((e) => fired.push(e.key));
    queue.upsert({ ...entry("x:refresh", 1000), accountId: "x" });
    queue.upsert({ ...entry("x:reset-check", 1000), accountId: "x" });
    queue.upsert({ ...entry("y:refresh", 1000), accountId: "y" });
    queue.removeAccount("i", "x");
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(["y:refresh"]);
  });

  it("clears all timers on stop and ignores later entries", () => {
    const queue = new PoolTimerQueue(() => undefined);
    queue.upsert(entry("a", 1000));
    queue.stop();
    queue.upsert(entry("b", 1000));
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.list()).toEqual([]);
  });
});
