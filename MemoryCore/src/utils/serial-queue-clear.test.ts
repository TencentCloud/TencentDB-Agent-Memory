/**
 * Regression tests for `SerialQueue.clear()` (issue #1039).
 *
 * `clear()` rejects and drops the pending tasks but never touched
 * `idleResolvers`. Those waiters are only notified from the task-completion
 * path in `drain()`, which never runs for discarded work — so a queue cleared
 * while paused reported `idle === true` while an `onIdle()` promise that had
 * already been handed to a caller stayed pending forever.
 *
 * The same defect exists in `MemoryKnowledge/src/store/serial-queue.ts`.
 */
import { describe, it, expect } from "vitest";
import { SerialQueue } from "./serial-queue.js";

/** Resolves to the string `literal` if `promise` settles first. */
function raceWithTimeout(promise: Promise<unknown>, literal: string, timeoutMs = 50): Promise<string> {
  return Promise.race([
    promise.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve(literal), timeoutMs)),
  ]);
}

describe("SerialQueue.clear", () => {
  it("releases onIdle() waiters when a paused queue is cleared", async () => {
    const queue = new SerialQueue("paused");
    queue.pause();

    const task = queue.add(async () => "never-runs").catch(() => "cleared");
    const idle = queue.onIdle();

    queue.clear();

    await expect(task).resolves.toBe("cleared");
    await expect(raceWithTimeout(idle, "timeout")).resolves.toBe("settled");
    expect(queue.idle).toBe(true);
    expect(queue.size).toBe(0);
  });

  it("does not resolve onIdle() while a task is still running", async () => {
    const queue = new SerialQueue("running");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // One task starts immediately; the second stays queued behind it.
    const first = queue.add(async () => {
      await gate;
    });
    const second = queue.add(async () => "cleared").catch(() => "cleared");
    const idle = queue.onIdle();

    queue.clear();
    release?.();
    await first;

    // The running task's `finally` is responsible for the waiters now, and it
    // must still resolve them even though the queue was cleared underneath it.
    await expect(raceWithTimeout(idle, "timeout")).resolves.toBe("settled");
    await expect(second).resolves.toBe("cleared");
  });

  it("is a no-op for onIdle() when the queue is already idle", async () => {
    const queue = new SerialQueue("empty");
    await expect(raceWithTimeout(queue.onIdle(), "timeout")).resolves.toBe("settled");
    expect(() => queue.clear()).not.toThrow();
    await expect(raceWithTimeout(queue.onIdle(), "timeout")).resolves.toBe("settled");
  });
});
