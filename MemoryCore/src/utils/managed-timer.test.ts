import { setTimeout as wait } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedTimer } from "./managed-timer.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const timers: ManagedTimer[] = [];
function timer(): ManagedTimer {
  const result = new ManagedTimer("test");
  timers.push(result);
  return result;
}

afterEach(() => {
  for (const result of timers.splice(0)) result.cancel();
  vi.useRealTimers();
});

describe("ManagedTimer long deadlines", () => {
  it.each(["schedule", "scheduleAt"] as const)("does not fire %s early when Node's timeout range is exceeded", async (method) => {
    // Real Node timers deliberately clamp overflowing delays to 1 ms.
    const result = timer();
    const callback = vi.fn();
    if (method === "schedule") result.schedule(MAX_TIMEOUT_MS + 10_000, callback);
    else result.scheduleAt(Date.now() + MAX_TIMEOUT_MS + 10_000, callback);
    await wait(25);
    expect(callback).not.toHaveBeenCalled();
    expect(result.pending).toBe(true);
  });

  it("rearms the remaining delay and fires exactly once at the original deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const result = timer();
    const callback = vi.fn();
    const deadline = Date.now() + MAX_TIMEOUT_MS + 1_000;
    result.scheduleAt(deadline, callback);
    vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    expect(callback).not.toHaveBeenCalled();
    expect(result.scheduledTime).toBe(deadline);
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.pending).toBe(false);
    expect(result.scheduledTime).toBe(0);
  });

  it("supports advancing, cancelling and flushing a long deadline", () => {
    vi.useFakeTimers();
    const result = timer();
    const callback = vi.fn();
    result.schedule(MAX_TIMEOUT_MS + 1_000, callback);
    expect(result.tryAdvanceTo(Date.now() + 10, callback)).toBe(true);
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);
    result.schedule(MAX_TIMEOUT_MS + 1_000, callback);
    result.cancel();
    expect(result.pending).toBe(false);
    result.schedule(MAX_TIMEOUT_MS + 1_000, callback);
    result.flush();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(result.pending).toBe(false);
  });
});
