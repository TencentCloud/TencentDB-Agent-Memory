import { describe, expect, it, vi } from "vitest";

import { createTelemetrySigtermHandler } from "./telemetry.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTelemetrySigtermHandler", () => {
  it("flushes telemetry before terminating and ignores duplicate signals", async () => {
    const pending = deferred();
    const shutdown = vi.fn(() => pending.promise);
    const terminate = vi.fn();
    const handler = createTelemetrySigtermHandler({ shutdown }, terminate);

    handler();
    handler();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();

    pending.resolve();
    await pending.promise;
    await Promise.resolve();

    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("still terminates when telemetry shutdown fails", async () => {
    const terminate = vi.fn();
    const handler = createTelemetrySigtermHandler({
      shutdown: vi.fn(async () => {
        throw new Error("flush failed");
      }),
    }, terminate);

    handler();
    await vi.waitFor(() => {
      expect(terminate).toHaveBeenCalledTimes(1);
    });
  });
});
