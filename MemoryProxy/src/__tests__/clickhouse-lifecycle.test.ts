import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@clickhouse/client", () => ({
  createClient: mocks.createClient,
}));

import {
  __resetClickHouseForTests,
  initClickHouse,
  shutdownClickHouse,
  type ClickHouseConfig,
} from "../clickhouse.js";

const config: ClickHouseConfig = {
  enabled: true,
  url: "http://clickhouse.test:8123",
  database: "memory",
  table: "usage_logs",
  rawTable: "",
  user: "default",
  password: "",
  flushIntervalMs: 5_000,
  flushThreshold: 50,
  ttlDays: 0,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function client(command = vi.fn().mockResolvedValue(undefined)) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    command,
    insert: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ClickHouse writer lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await __resetClickHouseForTests();
    vi.restoreAllMocks();
  });

  it("deduplicates repeated initialization", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const bootstrap = client();
    const target = client();
    mocks.createClient
      .mockReturnValueOnce(bootstrap)
      .mockReturnValueOnce(target);

    initClickHouse(config);
    initClickHouse(config);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await shutdownClickHouse();

    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(bootstrap.close).toHaveBeenCalledTimes(1);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight initialization before closing", async () => {
    const targetDdl = deferred();
    const bootstrap = client();
    const target = client(
      vi.fn()
        .mockReturnValueOnce(targetDdl.promise)
        .mockResolvedValue(undefined),
    );
    mocks.createClient
      .mockReturnValueOnce(bootstrap)
      .mockReturnValueOnce(target);

    initClickHouse(config);
    try {
      await vi.waitFor(() => {
        expect(target.command).toHaveBeenCalledTimes(1);
      });

      let shutdownComplete = false;
      const shutdown = shutdownClickHouse().then(() => {
        shutdownComplete = true;
      });
      await Promise.resolve();

      expect(shutdownComplete).toBe(false);
      expect(target.close).not.toHaveBeenCalled();

      targetDdl.resolve();
      await shutdown;

      expect(target.close).toHaveBeenCalledTimes(1);
    } finally {
      targetDdl.resolve();
    }
  });

  it("allows retry after initialization fails", async () => {
    const firstBootstrap = client();
    const firstTarget = client(
      vi.fn().mockRejectedValueOnce(new Error("DDL unavailable")),
    );
    const secondBootstrap = client();
    const secondTarget = client();
    mocks.createClient
      .mockReturnValueOnce(firstBootstrap)
      .mockReturnValueOnce(firstTarget)
      .mockReturnValueOnce(secondBootstrap)
      .mockReturnValueOnce(secondTarget);

    initClickHouse(config);
    await vi.waitFor(() => {
      expect(firstTarget.close).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();

    initClickHouse(config);
    await shutdownClickHouse();

    expect(mocks.createClient).toHaveBeenCalledTimes(4);
    expect(secondTarget.close).toHaveBeenCalledTimes(1);
  });
});
