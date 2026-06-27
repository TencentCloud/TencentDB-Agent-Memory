import { describe, it, expect } from "vitest";
import { AsyncSemaphore, PASSTHROUGH_LIMITER } from "./async-semaphore.js";

/** Resolve after the given ms (real timer — these tests exercise async timing). */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `n` tasks through `limiter`, each holding for `holdMs`, and report the
 * peak number observed running at once. With a cap of `k`, peak must be ≤ k.
 */
async function peakConcurrency(
  limiter: { run<T>(fn: () => Promise<T>): Promise<T> },
  n: number,
  holdMs: number,
): Promise<number> {
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: n }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(holdMs);
        active--;
      }),
    ),
  );
  return peak;
}

describe("AsyncSemaphore", () => {
  it("caps concurrency at the configured limit", async () => {
    const sem = new AsyncSemaphore(2);
    expect(await peakConcurrency(sem, 6, 15)).toBe(2);
    // Fully drained afterwards.
    expect(sem.active).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it("serializes when the limit is 1", async () => {
    const sem = new AsyncSemaphore(1);
    expect(await peakConcurrency(sem, 5, 10)).toBe(1);
  });

  it("treats limit <= 0 as unlimited (no gating)", async () => {
    for (const lim of [0, -1, Number.NaN]) {
      const sem = new AsyncSemaphore(lim);
      expect(sem.unlimited).toBe(true);
      expect(sem.capacity).toBe(0);
      // All 8 run together — peak equals the task count.
      expect(await peakConcurrency(sem, 8, 10)).toBe(8);
    }
  });

  it("PASSTHROUGH_LIMITER runs everything immediately", async () => {
    expect(await peakConcurrency(PASSTHROUGH_LIMITER, 5, 10)).toBe(5);
  });

  it("serves waiters in FIFO order", async () => {
    const sem = new AsyncSemaphore(1);
    const order: number[] = [];
    const release0Holder: Promise<() => void> = sem.acquire();
    const release0 = await release0Holder; // hold the only permit

    // Queue three waiters; they must run in the order they queued.
    const waiters = [1, 2, 3].map((i) =>
      sem.run(async () => {
        order.push(i);
        await delay(5);
      }),
    );

    expect(sem.waiting).toBe(3);
    release0(); // let them through one at a time
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it("never over-subscribes when an acquire races a release", async () => {
    // Regression guard for the classic handoff bug: releasing while a waiter is
    // queued must hand the permit over without transiently freeing a slot that
    // a synchronously-racing acquire() could grab.
    const sem = new AsyncSemaphore(1);
    const r1 = await sem.acquire(); // inUse=1
    const w = sem.acquire(); // queued waiter
    expect(sem.waiting).toBe(1);

    r1(); // hand permit to the queued waiter
    // Synchronously race a third acquire before the waiter's microtask resolves.
    let thirdGotPermit = false;
    const third = sem.acquire().then((rel) => {
      thirdGotPermit = true;
      return rel;
    });

    const r2 = await w; // waiter got the permit
    expect(sem.active).toBe(1);
    expect(thirdGotPermit).toBe(false); // third still blocked — no over-subscription

    r2();
    const r3 = await third;
    expect(thirdGotPermit).toBe(true);
    r3();
    expect(sem.active).toBe(0);
  });

  it("release is idempotent (double-release does not free extra permits)", async () => {
    const sem = new AsyncSemaphore(1);
    const rel = await sem.acquire();
    expect(sem.active).toBe(1);
    rel();
    rel(); // no-op
    expect(sem.active).toBe(0);

    // A fresh acquire still works and the limit is intact.
    expect(await peakConcurrency(sem, 3, 5)).toBe(1);
  });

  it("propagates task errors while still releasing the permit", async () => {
    const sem = new AsyncSemaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Permit was released despite the throw.
    expect(sem.active).toBe(0);
    expect(await peakConcurrency(sem, 2, 5)).toBe(1);
  });

  it("reports live active / waiting counts", async () => {
    const sem = new AsyncSemaphore(2);
    const rels = await Promise.all([sem.acquire(), sem.acquire()]);
    expect(sem.active).toBe(2);
    expect(sem.available).toBe(0);

    const queued = sem.acquire();
    expect(sem.waiting).toBe(1);

    rels[0]!();
    const rel3 = await queued;
    expect(sem.waiting).toBe(0);
    expect(sem.active).toBe(2);

    rels[1]!();
    rel3();
    expect(sem.active).toBe(0);
  });
});
