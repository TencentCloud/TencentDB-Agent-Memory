import { describe, it, expect } from "vitest";
import { KeyedAsyncMutex } from "./keyed-mutex.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("KeyedAsyncMutex", () => {
  it("serializes critical sections sharing a key (no interleave)", async () => {
    const m = new KeyedAsyncMutex();
    const trace: string[] = [];

    const section = (id: string) =>
      m.run("k", async () => {
        trace.push(`${id}:start`);
        await tick();
        await tick();
        trace.push(`${id}:end`);
      });

    await Promise.all([section("a"), section("b"), section("c")]);

    // Each section's start is immediately followed by its own end — never
    // another section's start in between.
    expect(trace).toEqual([
      "a:start", "a:end",
      "b:start", "b:end",
      "c:start", "c:end",
    ]);
  });

  it("runs in strict FIFO (call) order for the same key", async () => {
    const m = new KeyedAsyncMutex();
    const order: number[] = [];
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      m.run("k", async () => {
        await tick();
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("lets different keys proceed concurrently", async () => {
    const m = new KeyedAsyncMutex();
    let aInside = false;
    let bSawAInside = false;

    const a = m.run("a", async () => {
      aInside = true;
      await tick();
      await tick();
      aInside = false;
    });
    // Give "a" a chance to enter its section first.
    await tick();
    const b = m.run("b", async () => {
      bSawAInside = aInside; // a different key must not block on a's lock
    });

    await Promise.all([a, b]);
    expect(bSawAInside).toBe(true);
  });

  it("returns the critical section's value to the caller", async () => {
    const m = new KeyedAsyncMutex();
    await expect(m.run("k", async () => 42)).resolves.toBe(42);
  });

  it("a throwing section rejects only that caller and does not poison the key", async () => {
    const m = new KeyedAsyncMutex();
    const ran: string[] = [];

    const bad = m.run("k", async () => {
      ran.push("bad");
      throw new Error("boom");
    });
    const good = m.run("k", async () => {
      ran.push("good");
      return "ok";
    });

    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok"); // next waiter still runs
    expect(ran).toEqual(["bad", "good"]);
  });

  it("releases the key when idle (map does not grow unbounded)", async () => {
    const m = new KeyedAsyncMutex();
    expect(m.activeKeys).toBe(0);

    const p = m.run("k", async () => {
      // While held, the key is tracked.
      expect(m.activeKeys).toBe(1);
    });
    await p;
    // Once the last holder releases, the key is dropped.
    expect(m.activeKeys).toBe(0);

    // A fresh acquire on the same key still works after cleanup.
    await expect(m.run("k", async () => "again")).resolves.toBe("again");
    expect(m.activeKeys).toBe(0);
  });

  it("keeps the key while waiters remain, drops it after the last drains", async () => {
    const m = new KeyedAsyncMutex();
    const p1 = m.run("k", async () => {
      await tick();
    });
    const p2 = m.run("k", async () => {
      await tick();
    });
    // Two holders queued on one key → exactly one key tracked.
    expect(m.activeKeys).toBe(1);
    await Promise.all([p1, p2]);
    expect(m.activeKeys).toBe(0);
  });
});
