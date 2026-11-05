import { describe, expect, it } from "vitest";
import { flushPendingWrites, trackWrite } from "../pending-writes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("flushPendingWrites", () => {
  it("waits for writes registered after the flush starts", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    trackWrite(first.promise);

    const flush = flushPendingWrites(1_000);
    await Promise.resolve();
    trackWrite(second.promise);
    first.resolve();

    const earlyOutcome = await Promise.race([
      flush.then((result) => result),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    expect(earlyOutcome).toBe("still-pending");

    second.resolve();
    await expect(flush).resolves.toEqual({ drained: true, remaining: 0 });
  });
});
