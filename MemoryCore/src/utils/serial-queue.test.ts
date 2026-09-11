/**
 * Tests for #518 — SerialQueue must not deadlock when a queued task throws
 * synchronously. Previously drain() called entry.task() directly; a sync throw
 * escaped before .finally() was registered, leaving running=true forever so
 * every later add() hung and onIdle() never resolved.
 */

import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serial-queue.js";

function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    timeout(ms).then(() => {
      throw new Error(`${label}: timed out after ${ms}ms`);
    }),
  ]);
}

describe("SerialQueue sync-throw resilience (#518)", () => {
  it("recovers and runs subsequent tasks after a synchronous throw", async () => {
    const queue = new SerialQueue("repro");

    await queue
      .add(() => {
        throw new Error("sync failure");
      })
      .catch(() => undefined);

    const next = queue.add(async () => "ran");
    const outcome = await withTimeout(next, 500, "second task");

    expect(outcome).toBe("ran");
    expect(queue.size).toBe(0);
    expect(queue.pending).toBe(false);
    expect(queue.idle).toBe(true);
  });

  it("keeps FIFO order across a mix of sync-throw and async tasks", async () => {
    const queue = new SerialQueue("fifo");
    const order: string[] = [];

    const p1 = queue.add(() => {
      order.push("t1");
      return Promise.resolve("ok1");
    });
    const p2 = queue.add(() => {
      throw new Error("t2 boom");
    }).catch(() => "caught2");
    const p3 = queue.add(async () => {
      order.push("t3");
      return "ok3";
    });

    const [r1, r2, r3] = await withTimeout(Promise.all([p1, p2, p3]), 500, "all tasks");

    expect(r1).toBe("ok1");
    expect(r2).toBe("caught2");
    expect(r3).toBe("ok3");
    expect(order).toEqual(["t1", "t3"]);
    expect(queue.idle).toBe(true);
  });

  it("onIdle() resolves after a sync-throw task is drained", async () => {
    const queue = new SerialQueue("idle");

    const idleP = queue.onIdle();
    queue.add(() => {
      throw new Error("sync");
    }).catch(() => undefined);
    await queue.add(async () => "done");

    await withTimeout(idleP, 500, "onIdle");
    expect(queue.idle).toBe(true);
  });

  it("does not double-run a task after a sync throw", async () => {
    const queue = new SerialQueue("no-double");
    let calls = 0;

    queue.add(() => {
      calls++;
      throw new Error("sync boom");
    }).catch(() => undefined);

    await queue.add(async () => "after");
    // entry.resolve runs inside .then(), while running=false lands in the
    // following .finally() — wait on onIdle() for the bookkeeping to finish.
    await withTimeout(queue.onIdle(), 500, "onIdle");

    expect(calls).toBe(1);
    expect(queue.idle).toBe(true);
  });
});
