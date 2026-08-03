import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createClient: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@clickhouse/client", () => ({
  createClient: mocks.createClient,
}));

import { ClickHouseDirectExporter } from "./clickhouse-exporter.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("ClickHouseDirectExporter shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({
      close: mocks.close,
      insert: mocks.insert,
    });
    mocks.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for threshold-triggered inserts before closing once", async () => {
    const insert = deferred();
    mocks.insert.mockReturnValueOnce(insert.promise);
    const exporter = new ClickHouseDirectExporter({
      batchSize: 1,
      flushIntervalMs: 60_000,
    });

    exporter.exportLog({ body: "pending log" });
    const firstShutdown = exporter.shutdown();
    const secondShutdown = exporter.shutdown();

    expect(secondShutdown).toBe(firstShutdown);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();

    insert.resolve();
    await firstShutdown;

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes rows requeued by a failed in-flight insert before closing", async () => {
    const insert = deferred();
    mocks.insert
      .mockReturnValueOnce(insert.promise)
      .mockResolvedValueOnce(undefined);
    const exporter = new ClickHouseDirectExporter({
      batchSize: 1,
      flushIntervalMs: 60_000,
    });

    exporter.exportLog({ body: "retry on shutdown" });
    const shutdown = exporter.shutdown();

    insert.reject(new Error("temporary failure"));
    await shutdown;

    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
