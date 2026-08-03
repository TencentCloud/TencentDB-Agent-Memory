import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MetadataStorePool } from "./factory.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});

describe("MetadataStorePool", () => {
  it("deduplicates concurrent initialization for the same instance", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "metadata-store-pool-"));
    const pool = new MetadataStorePool({
      backend: "sqlite",
      sqliteBaseDir: baseDir,
    });
    cleanup.push(async () => {
      await pool.closeAll();
      await rm(baseDir, { recursive: true, force: true });
    });

    const stores = await Promise.all([
      pool.getStore("instance-1"),
      pool.getStore("instance-1"),
      pool.getStore("instance-1"),
    ]);

    expect(stores[1]).toBe(stores[0]);
    expect(stores[2]).toBe(stores[0]);
  });
});
