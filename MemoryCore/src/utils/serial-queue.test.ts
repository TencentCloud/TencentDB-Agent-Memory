import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  it("runs tasks serially in FIFO order", async () => {
    const queue = new SerialQueue("fifo");
    const order: number[] = [];
    await Promise.all([
      queue.add(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      queue.add(async () => {
        order.push(2);
      }),
      queue.add(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
    // running=false is flipped in the drain chain's .finally, one microtask
    // after the last caller promise resolves — wait for idle, don't poll it.
    await queue.onIdle();
    expect(queue.idle).toBe(true);
  });

  it("rejects the caller on async task failure and keeps draining", async () => {
    const queue = new SerialQueue("async-fail");
    await expect(queue.add(async () => {
      throw new Error("async failure");
    })).rejects.toThrow("async failure");
    await expect(queue.add(async () => "recovered")).resolves.toBe("recovered");
    await queue.onIdle();
    expect(queue.idle).toBe(true);
  });

  // Regression for #518: a task that throws before returning its promise used
  // to escape drain() ahead of the .finally() bookkeeping, leaving the queue
  // permanently stuck with running=true.
  it("recovers from a synchronously-throwing task (#518)", async () => {
    const queue = new SerialQueue("sync-throw");

    await expect(
      queue.add((() => {
        throw new Error("sync failure");
      }) as () => Promise<never>),
    ).rejects.toThrow("sync failure");

    // onIdle() must resolve rather than wait forever (hung before the fix)...
    await queue.onIdle();

    // ...queue bookkeeping must be finalized...
    expect(queue.pending).toBe(false);
    expect(queue.size).toBe(0);

    // ...and the next task must actually run (also hung before the fix).
    await expect(queue.add(async () => "ran")).resolves.toBe("ran");
    await queue.onIdle();
    expect(queue.idle).toBe(true);
  });

  it("resolves onIdle() waiters after a sync throw with queued followers", async () => {
    const queue = new SerialQueue("sync-throw-idle");
    const results: string[] = [];

    const first = queue
      .add((() => {
        throw new Error("boom");
      }) as () => Promise<never>)
      .catch(() => results.push("first-rejected"));
    const second = queue.add(async () => {
      results.push("second-ran");
    });

    await queue.onIdle();
    await Promise.all([first, second]);
    expect(results).toEqual(["first-rejected", "second-ran"]);
  });
});
