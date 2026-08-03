import { afterEach, describe, expect, it, vi } from "vitest";

import {
  flushPendingWrites,
  pendingWriteCount,
  trackWrite,
} from "../pending-writes.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("flushPendingWrites", () => {
  it("clears the deadline timer when writes drain early", async () => {
    vi.useFakeTimers();
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    trackWrite(write);

    const flushing = flushPendingWrites(10_000);
    expect(vi.getTimerCount()).toBe(1);

    resolveWrite();
    await expect(flushing).resolves.toEqual({ drained: true, remaining: 0 });

    expect(pendingWriteCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports pending writes and clears the fired deadline timer", async () => {
    vi.useFakeTimers();
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    trackWrite(write);

    const flushing = flushPendingWrites(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(flushing).resolves.toEqual({ drained: false, remaining: 1 });
    expect(vi.getTimerCount()).toBe(0);

    resolveWrite();
    await write;
    await Promise.resolve();
    expect(pendingWriteCount()).toBe(0);
  });
});
