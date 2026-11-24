import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfileIsolationScope, buildProfileStableId } from "../../src/core/profile/profile-scope.js";
import { listLocalProfiles, pullProfilesToLocal, syncLocalProfilesToStore } from "../../src/core/profile/profile-sync.js";
import { StorageAdapter } from "../../src/core/storage/adapter.js";
import { FakeProfileRowStore } from "../../src/core/storage/__contract__/fake-profile-row-store.js";
import { LocalStorageBackend } from "../../src/core/storage/local-backend.js";
import type { IMemoryStore, ProfileRecord } from "../../src/core/store/types.js";

const isolation = { teamId: "team-a", agentId: "agent-a" };
const scope = buildProfileIsolationScope(isolation);
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function profile(filename: string, content: string): ProfileRecord {
  return {
    id: buildProfileStableId(scope, "l2", filename), type: "l2", filename, content,
    contentMd5: createHash("md5").update(content).digest("hex"),
    teamId: isolation.teamId, agentId: isolation.agentId,
    version: 1, createdAtMs: 1000, updatedAtMs: 1000,
  };
}

// Real temporary files + production local backend/adapter + sync orchestration.
// Only the remote profile persistence boundary uses the existing contract double.
describe("L2 profile filesystem synchronization", () => {
  let directory: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tdai-profile-integration-"));
    storage = new StorageAdapter(new LocalStorageBackend(directory));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["filesystem", "storage-adapter"] as const)("includes nested scenes in the %s profile snapshot", async (mode) => {
    await storage.writeFile("scene_blocks/root.md", "root scene");
    await storage.writeFile("scene_blocks/work/q1.md", "nested scene");
    await storage.writeFile("scene_blocks/work/deep/q2.md", "deep scene");
    await storage.writeFile("scene_blocks/work/notes.txt", "not a profile");
    const rows = await listLocalProfiles(directory, mode === "storage-adapter" ? storage : undefined, { isolation });
    expect(rows.map((row) => row.filename).sort()).toEqual(["root.md", "work/deep/q2.md", "work/q1.md"]);
    expect(rows.find((row) => row.filename === "work/q1.md")).toMatchObject({
      id: buildProfileStableId(scope, "l2", "work/q1.md"), content: "nested scene", ...isolation,
    });
  });

  it.each(["filesystem", "storage-adapter"] as const)("preserves a nested remote scene across the %s pull/sync round trip", async (mode) => {
    const remote = new FakeProfileRowStore();
    const row = profile("work/q1.md", "nested remote scene");
    await remote.syncProfiles([row]);
    const store = remote.asStore() as IMemoryStore;
    const adapter = mode === "storage-adapter" ? storage : undefined;
    const baseline = await pullProfilesToLocal(directory, store, logger, adapter, { isolation });
    expect(await readFile(join(directory, "scene_blocks", "work", "q1.md"), "utf8")).toBe(row.content);
    await syncLocalProfilesToStore(directory, store, baseline, logger, adapter, { isolation });
    expect(await remote.queryProfilesByIds([row.id])).toEqual([row]);
  });

  it("keeps a nested local scene when the remote checksum is corrupt", async () => {
    const remote = new FakeProfileRowStore();
    const corrupt = { ...profile("work/q1.md", "remote text"), contentMd5: "invalid-checksum" };
    await remote.syncProfiles([corrupt]);
    await mkdir(join(directory, "scene_blocks", "work"), { recursive: true });
    await writeFile(join(directory, "scene_blocks", "work", "q1.md"), "last verified snapshot");
    await pullProfilesToLocal(directory, remote.asStore() as IMemoryStore, logger, undefined, { isolation });
    expect(await readFile(join(directory, "scene_blocks", "work", "q1.md"), "utf8")).toBe("last verified snapshot");
  });

  it.each(["filesystem", "storage-adapter"] as const)("removes nested scenes actually deleted remotely in %s mode", async (mode) => {
    const remote = new FakeProfileRowStore();
    const retained = profile("work/keep.md", "retained scene");
    await remote.syncProfiles([retained]);
    await storage.writeFile("scene_blocks/work/deleted.md", "stale local scene");
    const adapter = mode === "storage-adapter" ? storage : undefined;
    await pullProfilesToLocal(directory, remote.asStore() as IMemoryStore, logger, adapter, { isolation });
    expect(await storage.readFile("scene_blocks/work/deleted.md")).toBeNull();
    expect(await storage.readFile("scene_blocks/work/keep.md")).toBe("retained scene");
  });
});
