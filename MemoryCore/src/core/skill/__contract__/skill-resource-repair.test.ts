import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSkillStore } from "../../store/sqlite/skill-store.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { LocalStorageBackend } from "../../storage/local-backend.js";
import { SkillResourceStore } from "../skill-resource-store.js";
import { SkillVersioning } from "../skill-versioning.js";
import { SkillCore } from "../skill-core.js";

const actor = { user_id: "user", team_id: "team", agent_id: "owner", task_id: "task" };
const content = "---\nname: resource-repair\ndescription: Repair a resource package\n---\n\nRead the resources.";
const file = (path: string, content: string) => ({ path, content, encoding: "utf-8" as const });

describe("ordinary resource repair (real SQLite and local storage)", () => {
  let root: string, db: DatabaseSync, storage: StorageAdapter, core: SkillCore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-resource-repair-"));
    db = new DatabaseSync(":memory:");
    const store = new SqliteSkillStore({ db, dimensions: 0 }); store.init();
    storage = new StorageAdapter(new LocalStorageBackend(root));
    const resources = new SkillResourceStore({ storage });
    core = new SkillCore({ store, resources, versioning: new SkillVersioning({ store, resources, storage }) });
  });
  afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

  it.each(["missing", "corrupt"] as const)("can explicitly replace %s bytes, even with the original content", async damage => {
    const first = await core.create({ ...actor, name: "resource-repair", content, resources: [file("lost.txt", "original"), file("keep.txt", "keep")] });
    if (damage === "missing") await storage.rmdir(`${first.storage_dir}/files/lost.txt`);
    else await storage.writeFile(`${first.storage_dir}/files/lost.txt`, "tampered");
    const repaired = await core.writeFiles({ ...actor, skill_id: first.skill_id, expected_version: 1, files: [file("lost.txt", "original")] });
    expect(repaired.version).toBe(2);
    expect(await storage.readFile(`${repaired.storage_dir}/files/lost.txt`)).toBe("original");
    expect(await storage.readFile(`${repaired.storage_dir}/files/keep.txt`)).toBe("keep");
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    expect([...repaired.manifest].sort(byPath)).toEqual([...first.manifest].sort(byPath));
  });

  it.each(["missing", "corrupt"] as const)("can explicitly remove %s bytes without losing other resources", async damage => {
    const first = await core.create({ ...actor, name: "resource-repair", content, resources: [file("lost.txt", "original"), file("keep.txt", "keep")] });
    if (damage === "missing") await storage.rmdir(`${first.storage_dir}/files/lost.txt`);
    else await storage.writeFile(`${first.storage_dir}/files/lost.txt`, "tampered");
    const repaired = await core.removeFiles({ ...actor, skill_id: first.skill_id, expected_version: 1, paths: ["lost.txt"] });
    expect(repaired.version).toBe(2);
    expect(repaired.manifest.map(entry => entry.path)).toEqual(["keep.txt"]);
    expect(await storage.readFile(`${repaired.storage_dir}/files/keep.txt`)).toBe("keep");
  });

  it("still refuses to silently inherit a missing resource while replacing another", async () => {
    const first = await core.create({ ...actor, name: "resource-repair", content, resources: [file("lost.txt", "original"), file("keep.txt", "keep")] });
    await storage.rmdir(`${first.storage_dir}/files/lost.txt`);
    await expect(core.writeFiles({ ...actor, skill_id: first.skill_id, expected_version: 1, files: [file("keep.txt", "changed")] }))
      .rejects.toMatchObject({ code: "RESOURCE_INTEGRITY_ERROR" });
    expect((await core.get({ ...actor, skill_id: first.skill_id })).version).toBe(1);
  });
});
