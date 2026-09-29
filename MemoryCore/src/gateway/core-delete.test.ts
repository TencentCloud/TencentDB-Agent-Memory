import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCoreWrite, handleCoreRead, handleCoreCount, handleCoreDelete } from "./v2-router.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { V2AuthContext } from "./v2-schemas.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";

// Regression test for issue #1525: L3 persona (core) had read/write/count but
// no delete endpoint, so a per-triplet data-removal workflow was impossible.
// These exercise the storage side of core/delete with getStore() → undefined,
// so the VDB-profile and audit hooks safely no-op and the test needs no DB.

const AUTH: V2AuthContext = { apiKey: "test", serviceId: "default" };
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };

function isolation(userId: string, agentId: string) {
  return { userId, agentId, sessionId: "s1" };
}

describe("core/delete (L3 persona)", () => {
  let root: string;
  let storage: StorageAdapter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tam-core-delete-"));
    storage = new StorageAdapter(new LocalStorageBackend({ rootDir: root }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(userId: string, agentId: string): V2RouterDeps {
    return {
      getStore: () => undefined,
      getEmbedding: () => undefined,
      getStorage: () => storage,
      logger,
      deployMode: "standalone",
      requestIsolation: isolation(userId, agentId),
    };
  }

  it("write → delete → read returns empty; count drops to 0", async () => {
    const d = deps("userA", "agentA");

    const written = await handleCoreWrite({ content: "I prefer concise answers." }, AUTH, "req-1", d);
    expect(written.code).toBe(0);
    expect((await handleCoreCount({}, AUTH, "req-2", d)).data).toEqual({ total: 1 });

    const deleted = await handleCoreDelete({}, AUTH, "req-3", d);
    expect(deleted.code).toBe(0);
    expect(deleted.data).toEqual({ deleted_count: 1, paths: ["persona.md"] });

    const read = await handleCoreRead({}, AUTH, "req-4", d);
    expect(read.data.content).toBeNull();
    expect((await handleCoreCount({}, AUTH, "req-5", d)).data).toEqual({ total: 0 });
  });

  it("delete on a triplet with no persona is a 200 no-op (deleted_count 0)", async () => {
    const deleted = await handleCoreDelete({}, AUTH, "req-1", deps("userA", "agentA"));
    expect(deleted.code).toBe(0);
    expect(deleted.data).toEqual({ deleted_count: 0, paths: [] });
  });

  it("deleting one triplet's persona leaves other triplets untouched", async () => {
    const a = deps("userA", "agentA");
    const b = deps("userB", "agentB");

    await handleCoreWrite({ content: "persona A" }, AUTH, "w-a", a);
    await handleCoreWrite({ content: "persona B" }, AUTH, "w-b", b);

    await handleCoreDelete({}, AUTH, "del-a", a);

    expect((await handleCoreRead({}, AUTH, "r-a", a)).data.content).toBeNull();
    expect((await handleCoreRead({}, AUTH, "r-b", b)).data.content).toBe("persona B");
  });
});
