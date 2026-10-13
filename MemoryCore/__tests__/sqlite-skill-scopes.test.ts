import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteSkillStore } from "../src/core/store/sqlite/skill-store.js";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const store = new SqliteSkillStore({ db, dimensions: 0 }); store.init();
  await store.appendVersion({ skill_id: "foreign", team_id: "other", owner_agent_id: "agent", user_id: "user", task_id: "task", name: "synthetic", description: "", content: "boundaryneedle", content_hash: "synthetic", manifest: [], storage_dir: "synthetic-unused" });
  return { store, db };
}
it("does not broaden explicitly empty team reads to every team", async () => {
  const { store } = await fixture();
  expect(await store.getHead("foreign", "")).toBeNull();
  expect(await store.getHeadIncludingArchived("foreign", "")).toBeNull();
  expect(await store.getByVersion("foreign", 1, "")).toBeNull();
  expect(await store.listVersions("foreign", "")).toEqual([]);
  expect(await store.countVersions("foreign", "")).toBe(0);
});
it("does not archive a foreign skill through an empty team filter", async () => {
  const { store } = await fixture(); expect(await store.archiveHead("foreign", "")).toEqual({ archived: false });
  expect(await store.getHead("foreign", "other")).not.toBeNull();
  expect(await store.searchSkills({ query: "boundaryneedle", team_id: "other" })).toHaveLength(1);
});
it("does not delete a foreign skill through an empty team filter", async () => {
  const { store } = await fixture(); expect(await store.deleteAllVersions("foreign", "")).toBe(0);
  expect(await store.getHead("foreign", "other")).not.toBeNull();
  expect(await store.searchSkills({ query: "boundaryneedle", team_id: "other" })).toHaveLength(1);
});
for (const field of ["team_id", "owner_agent_id", "user_id", "task_id"] as const) {
  it(`preserves an explicitly empty ${field} in list filtering`, async () => {
    const { store } = await fixture(); expect(await store.listSkills({ [field]: "" })).toEqual({ items: [], total: 0 });
  });
}
for (const field of ["team_id", "agent_id", "user_id", "task_id"] as const) {
  it(`preserves an explicitly empty ${field} in FTS filtering`, async () => {
    const { store } = await fixture(); expect(await store.searchSkills({ query: "boundaryneedle", [field]: "" })).toEqual([]);
  });
}
it("rechecks the authoritative row scope when an FTS entry has stale identity metadata", async () => {
  const { store, db } = await fixture();
  db.prepare("UPDATE skill_fts SET team_id=? WHERE skill_id=?").run("requested", "foreign");
  expect(await store.searchSkills({ query: "boundaryneedle", team_id: "requested" })).toEqual([]);
});
it("retains explicitly unscoped management reads and ordinary scoped versioning", async () => {
  const { store } = await fixture();
  const head = await store.getHead("foreign", "other"); expect(head?.version).toBe(1);
  expect(await store.getHead("foreign")).toEqual(head);
  expect((await store.listSkills({ team_id: "other" })).total).toBe(1);
  expect(await store.archiveHead("foreign", "other")).toEqual({ archived: true });
  expect(await store.archiveHead("foreign", "other")).toEqual({ archived: true });
  expect(await store.getHead("foreign", "other")).toBeNull();
  expect(await store.deleteAllVersions("foreign", "other")).toBe(1);
});
