import { afterEach, describe, expect, it, vi } from "vitest";
import type { IStateBackend, TimerEntry } from "../core/state/types.js";
import { TimerScanner } from "./timer-scanner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createBackend(
  claimExpiredFromShard: () => Promise<TimerEntry[]>,
): IStateBackend {
  return {
    timerShardCount: 1,
    claimExpiredFromShard,
    enqueueTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStateBackend;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TimerScanner lifecycle", () => {
  it("does not overlap interval scans while a shard claim is pending", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred<TimerEntry[]>();
    const claimExpiredFromShard = vi
      .fn<() => Promise<TimerEntry[]>>()
      .mockReturnValueOnce(firstClaim.promise)
      .mockResolvedValue([]);
    const scanner = new TimerScanner(
      createBackend(claimExpiredFromShard),
      { scanIntervalMs: 10 },
    );

    await scanner.start();
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(claimExpiredFromShard).toHaveBeenCalledTimes(1);
    } finally {
      firstClaim.resolve([]);
      await scanner.stop();
    }
  });

  it("waits for an active scan to drain before stop resolves", async () => {
    vi.useFakeTimers();
    const firstClaim = deferred<TimerEntry[]>();
    const backend = createBackend(() => firstClaim.promise);
    const scanner = new TimerScanner(backend, { scanIntervalMs: 10 });

    await scanner.start();
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopPromise = scanner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    try {
      expect(stopped).toBe(false);
      firstClaim.resolve([
        {
          member: "instance-1\u0000session-1:L1_idle",
          fireAtMs: Date.now(),
        },
      ]);
      await stopPromise;

      expect(backend.enqueueTask).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(true);
    } finally {
      firstClaim.resolve([]);
      await scanner.stop();
    }
  });
});
