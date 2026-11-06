import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSkillStore } from "../../store/sqlite/skill-store.js";
import type { AppendVersionInput } from "../types.js";
import { SKILLS_DDL } from "../skill-store-ddl.js";
import { runSkillStoreContract } from "./skill-store.contract.js";
import type { ISkillStore } from "../skill-store.interface.js";

const contractDatabases = new Map<ISkillStore, DatabaseSync>();
runSkillStoreContract({
  backend: "real SQLite publication regression",
  async createStore() {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init(); contractDatabases.set(store, db); return store;
  },
  async disposeStore(store) { contractDatabases.get(store)!.close(); contractDatabases.delete(store); },
});

const input = (over: Partial<AppendVersionInput> = {}): AppendVersionInput => ({
  skill_id: "s", team_id: "t", owner_agent_id: "a", name: "skill", description: "desc",
  content: "body", content_hash: "hash", manifest: [], storage_dir: "skills/s/attempt-a",
  expected_version: 0, mutation_id: "create", metadata_json: '{"user":{"keep":true}}', ...over,
});

describe("SQLite skill publication contract (real database)", () => {
  let db: DatabaseSync;
  let store: SqliteSkillStore;
  beforeEach(() => { db = new DatabaseSync(":memory:"); store = new SqliteSkillStore({ db, dimensions: 0 }); store.init(); });
  afterEach(() => db.close());

  it("migrates pre-publication schemas without rewriting user metadata", async () => {
    db.exec("DROP TABLE skills");
    db.exec(SKILLS_DDL.replace(/^.*mutation_(?:id|payload_hash|request_hash).*\n/gm, ""));
    db.prepare(`INSERT INTO skills (row_id,skill_id,version,is_head,user_id,owner_agent_id,team_id,task_id,name,description,content,content_hash,manifest_json,storage_dir,status,metadata_json,created_at_ms,updated_at_ms)
      VALUES ('legacy','s',1,1,'u','a','t','task','skill','desc','old','hash','[]','skills/s/v1','active','{"original":true}',1,1)`).run();
    store.init(); store.init();
    expect((await store.getHead("s", "t"))?.metadata_json).toBe('{"original":true}');
    const next = await store.appendVersion(input({ expected_version: 1, mutation_id: "upgrade" }));
    expect(next.version).toBe(2);
    expect((await store.getByMutationId("s", "upgrade", "t"))?.row_id).toBe(next.row_id);
  });

  it("rolls back head and mutation receipt together when FTS insertion fails", async () => {
    const first = await store.appendVersion(input());
    db.exec("DROP TABLE skill_fts");
    await expect(store.appendVersion(input({ expected_version: 1, mutation_id: "failed", content: "next" }))).rejects.toThrow();
    expect((await store.getHead("s", "t"))?.row_id).toBe(first.row_id);
    expect(await store.getByMutationId("s", "failed", "t")).toBeNull();
    expect(await store.countVersions("s", "t")).toBe(1);
  });

  it("replays only the same mutation and payload without overwriting user metadata", async () => {
    const first = await store.appendVersion(input());
    const retry = await store.appendVersion(input({ storage_dir: "skills/s/another-attempt" }));
    expect(retry.row_id).toBe(first.row_id);
    expect(retry.storage_dir).toBe(first.storage_dir);
    expect(retry.metadata_json).toBe('{"user":{"keep":true}}');
    expect(await store.countVersions("s", "t")).toBe(1);
  });

  it("requires byte fingerprints for explicit resource mutation idempotency", async () => {
    await expect(store.appendVersion(input({ manifest: [{ path: "x", size_bytes: 1, mime_type: "text/plain", is_executable: false }] })))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(await store.countVersions("s", "t")).toBe(0);
  });

  it("rejects same mutation id with different content, metadata, or manifest", async () => {
    await store.appendVersion(input());
    for (const over of [{ content: "changed" }, { metadata_json: '{"changed":true}' }, { manifest: [{ path: "x", size_bytes: 1, mime_type: "text/plain", is_executable: false }] }]) {
      await expect(store.appendVersion(input(over))).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    }
  });

  it("checks expected_version inside the write transaction and never silently rebases", async () => {
    await store.appendVersion(input());
    const results = await Promise.allSettled([
      store.appendVersion(input({ expected_version: 1, mutation_id: "one", content: "one" })),
      store.appendVersion(input({ expected_version: 1, mutation_id: "two", content: "two" })),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("SKILL_VERSION_STALE");
    expect((await store.getHead("s", "t"))?.version).toBe(2);
  });

  it("rejects create-on-existing and malformed expected versions", async () => {
    await store.appendVersion(input());
    await expect(store.appendVersion(input({ mutation_id: "other" }))).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    await expect(store.appendVersion(input({ expected_version: -1, mutation_id: "bad" }))).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });

  it("retains mutation identity after historical version cleanup", async () => {
    const first = await store.appendVersion(input());
    await store.appendVersion(input({ expected_version: 1, mutation_id: "next", content: "next" }));
    expect(await store.deleteVersion("s", 1)).toBe(true);
    expect((await store.appendVersion(input())).row_id).toBe(first.row_id);
    await expect(store.appendVersion(input({ expected_version: 2, content: "another intent" })))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(await store.countVersions("s", "t")).toBe(1);
  });

  it("replays a deleted skill's historical receipt without resurrecting its versions", async () => {
    const first = await store.appendVersion(input());
    expect(await store.deleteAllVersions("s", "t")).toBe(1);
    expect((await store.appendVersion(input())).row_id).toBe(first.row_id);
    expect((await store.getByMutationId("s", "create", "t"))?.row_id).toBe(first.row_id);
    expect(await store.getHead("s", "t")).toBeNull();
    expect(await store.countVersions("s", "t")).toBe(0);
    await expect(store.appendVersion(input({ content: "different" }))).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
  });

  it("tombstones deleted skill IDs so a different intent cannot recreate them", async () => {
    await store.appendVersion(input());
    expect(await store.deleteAllVersions("s", "t")).toBe(1);
    await expect(store.appendVersion(input({ mutation_id: "new-create", expected_version: 0 })))
      .rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    expect(await store.getHead("s", "t")).toBeNull();
    expect(await store.countVersions("s", "t")).toBe(0);
  });

  it("does not tombstone a skill when the deletion team does not match", async () => {
    await store.appendVersion(input());
    expect(await store.deleteAllVersions("s", "other-team")).toBe(0);
    expect((await store.appendVersion(input({ mutation_id: "next", expected_version: 1 }))).version).toBe(2);
  });

  it("rolls back the tombstone when deleting the version rows fails", async () => {
    await store.appendVersion(input());
    db.exec("CREATE TRIGGER reject_skill_delete BEFORE DELETE ON skills BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    await expect(store.deleteAllVersions("s", "t")).rejects.toThrow("blocked");
    db.exec("DROP TRIGGER reject_skill_delete");
    expect((await store.appendVersion(input({ mutation_id: "next", expected_version: 1 }))).version).toBe(2);
  });

  it("resolves committed mutations even after the head advances", async () => {
    const v1 = await store.appendVersion(input());
    await store.appendVersion(input({ expected_version: 1, mutation_id: "second", content: "v2" }));
    expect((await store.getByMutationId("s", "create", "t"))?.row_id).toBe(v1.row_id);
    expect(await store.getByMutationId("s", "missing", "t")).toBeNull();
  });
});
