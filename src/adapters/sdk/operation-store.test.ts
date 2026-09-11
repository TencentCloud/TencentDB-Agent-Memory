import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FileAdapterOperationStore } from "./operation-store.js";

const tempDirs: string[] = [];

async function createStore(options: { claimTtlMs?: number } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-adapter-sdk-"));
  tempDirs.push(stateDir);
  return {
    stateDir,
    store: new FileAdapterOperationStore({ stateDir, ...options }),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileAdapterOperationStore", () => {
  it("allows only one claim across store instances", async () => {
    const { stateDir, store } = await createStore();
    const second = new FileAdapterOperationStore({ stateDir });

    await expect(store.claim("capture-key")).resolves.toBe(true);
    await expect(second.claim("capture-key")).resolves.toBe(false);
  });

  it("keeps completed operations deduplicated across store instances", async () => {
    const { stateDir, store } = await createStore();
    await store.claim("capture-key");
    await store.complete("capture-key");

    const second = new FileAdapterOperationStore({ stateDir });
    await expect(second.claim("capture-key")).resolves.toBe(false);
  });

  it("allows a released operation to retry", async () => {
    const { stateDir, store } = await createStore();
    await store.claim("capture-key");
    await store.release("capture-key");

    const second = new FileAdapterOperationStore({ stateDir });
    await expect(second.claim("capture-key")).resolves.toBe(true);
  });

  it("recovers stale claim files", async () => {
    const { stateDir, store } = await createStore({ claimTtlMs: 1_000 });
    await store.claim("capture-key");
    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir)).map(async (file) => {
      const claimPath = path.join(stateDir, file);
      await writeFile(claimPath, JSON.stringify({ pid: "invalid", claimedAt: expiredAt.getTime() }));
      await utimes(claimPath, expiredAt, expiredAt);
    }));

    const second = new FileAdapterOperationStore({ stateDir, claimTtlMs: 1_000 });
    await expect(second.claim("capture-key")).resolves.toBe(true);
  });

  it("does not reclaim an expired claim while its owner process is alive", async () => {
    const { stateDir, store } = await createStore({ claimTtlMs: 1_000 });
    await store.claim("capture-key");
    const expiredAt = new Date(Date.now() - 2_000);
    await Promise.all((await readdir(stateDir)).map((file) => utimes(path.join(stateDir, file), expiredAt, expiredAt)));

    const second = new FileAdapterOperationStore({ stateDir, claimTtlMs: 1_000 });
    await expect(second.claim("capture-key")).resolves.toBe(false);
  });
});