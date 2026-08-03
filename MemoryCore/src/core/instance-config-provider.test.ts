import { describe, expect, it, vi } from "vitest";

import type { IConfigSource } from "./abstractions/index.js";
import {
  InstanceConfigProvider,
  type VdbConfig,
} from "./instance-config-provider.js";

const vdbConfig: VdbConfig = {
  url: "https://vdb.example.test",
  user: "test-user",
  apiKey: "test-key",
  database: "test-db",
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("InstanceConfigProvider cache invalidation", () => {
  it("does not repopulate an evicted entry from an older in-flight fetch", async () => {
    const request = deferred<VdbConfig>();
    const source: IConfigSource = {
      fetchVdb: vi.fn(() => request.promise),
      fetchCos: vi.fn(async () => null),
    };
    const provider = new InstanceConfigProvider({ source, logger });

    const pending = provider.resolveVdb("deleted-instance");
    provider.evictVdb("deleted-instance");
    request.resolve(vdbConfig);

    await expect(pending).resolves.toEqual(vdbConfig);
    expect(provider.poolSize).toBe(0);
  });

  it("keeps a fresh request after eviction separate from the stale request", async () => {
    const stale = deferred<VdbConfig>();
    const fresh = deferred<VdbConfig>();
    const fetchVdb = vi
      .fn<() => Promise<VdbConfig>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const source: IConfigSource = {
      fetchVdb,
      fetchCos: vi.fn(async () => null),
    };
    const provider = new InstanceConfigProvider({ source, logger });

    const stalePending = provider.resolveVdb("instance-1");
    provider.evictVdb("instance-1");
    const freshPending = provider.resolveVdb("instance-1");

    stale.resolve({ ...vdbConfig, database: "stale-db" });
    fresh.resolve({ ...vdbConfig, database: "fresh-db" });

    await expect(stalePending).resolves.toMatchObject({ database: "stale-db" });
    await expect(freshPending).resolves.toMatchObject({ database: "fresh-db" });
    await expect(provider.resolveVdb("instance-1")).resolves.toMatchObject({
      database: "fresh-db",
    });
    expect(fetchVdb).toHaveBeenCalledTimes(2);
    expect(provider.poolSize).toBe(1);
  });

  it("does not let an in-flight fetch repopulate the cache after clear", async () => {
    const request = deferred<VdbConfig>();
    const source: IConfigSource = {
      fetchVdb: vi.fn(() => request.promise),
      fetchCos: vi.fn(async () => null),
    };
    const provider = new InstanceConfigProvider({ source, logger });

    const pending = provider.resolveVdb("instance-to-clear");
    provider.clear();
    request.resolve(vdbConfig);

    await expect(pending).resolves.toEqual(vdbConfig);
    expect(provider.poolSize).toBe(0);
  });
});
