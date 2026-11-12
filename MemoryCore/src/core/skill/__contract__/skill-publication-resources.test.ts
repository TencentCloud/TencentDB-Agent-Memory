import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSkillStore } from "../../store/sqlite/skill-store.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { LocalStorageBackend } from "../../storage/local-backend.js";
import { SkillResourceStore } from "../skill-resource-store.js";
import { SkillVersioning, type AppendVersionMutation } from "../skill-versioning.js";

const ctx = { team_id: "t", agent_id: "a" };
const mut = (over: Partial<AppendVersionMutation> = {}): AppendVersionMutation => ({ content: "body", name: "skill", description: "desc", ...over });
const file = (path: string, content: string) => ({ path, content, encoding: "utf-8" as const });

describe("versioned resources (real SQLite and local storage)", () => {
  let root: string, db: DatabaseSync, store: SqliteSkillStore, storage: StorageAdapter, resources: SkillResourceStore, versions: SkillVersioning;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-publication-"));
    db = new DatabaseSync(":memory:"); store = new SqliteSkillStore({ db, dimensions: 0 }); store.init();
    storage = new StorageAdapter(new LocalStorageBackend(root)); resources = new SkillResourceStore({ storage });
    versions = new SkillVersioning({ store, storage, resources });
  });
  afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

  it("read/write/remove honor explicit storage_dir while legacy calls keep working", async () => {
    await resources.writeResource("s", 1, file("a.txt", "new"), "skills/s/attempt-x");
    expect(await storage.readFile("skills/s/attempt-x/files/a.txt")).toBe("new");
    expect(await resources.readResource("s", 1, "a.txt", "utf-8")).toBeNull();
    expect((await resources.readResource("s", 1, "a.txt", "utf-8", "skills/s/attempt-x"))?.content).toBe("new");
    await resources.removeResource("s", 1, "a.txt", "skills/s/attempt-x");
    expect(await storage.readFile("skills/s/attempt-x/files/a.txt")).toBeNull();
    await resources.writeResource("s", 1, file("old.txt", "old"));
    expect((await resources.readResource("s", 1, "old.txt", "utf-8"))?.content).toBe("old");
  });

  it("versions metadata-only, description-only, and resource-only changes", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut());
    const v2 = await versions.appendNextVersion(v1, ctx, mut({ metadata_json: '{"flag":true}' }));
    expect(v2.version).toBe(2);
    const v3 = await versions.appendNextVersion(v2, ctx, mut({ description: "changed" }));
    expect(v3.version).toBe(3);
    const v4 = await versions.appendNextVersion(v3, ctx, mut({ description: "changed", resourcesToWrite: [file("a.txt", "bytes")] }));
    expect(v4.version).toBe(4);
    const same = await versions.appendNextVersion(v4, ctx, mut({ description: "changed", resourcesToWrite: [file("a.txt", "bytes")] }));
    expect(same.row_id).toBe(v4.row_id);
  });

  it("uses manifest reads, preserving binary bytes and executable metadata", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut({ resourcesToWrite: [{ path: "run", content: "AP+A", encoding: "base64", mime_type: "x/test", is_executable: true }] }));
    vi.spyOn(storage, "copyTree").mockRejectedValue(new Error("copyTree must not be used"));
    const v2 = await versions.appendNextVersion(v1, ctx, mut({ content: "changed" }));
    expect(v2.manifest).toEqual(v1.manifest);
    expect((await resources.readResource("s", 2, "run", "base64", v2.storage_dir))?.content).toBe("AP+A");
  });

  it("missing manifest bytes abort publication instead of silently dropping resources", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut({ resourcesToWrite: [file("lost", "bytes")] }));
    await storage.rmdir(v1.storage_dir);
    await expect(versions.appendNextVersion(v1, ctx, mut({ content: "changed" }))).rejects.toMatchObject({ code: "RESOURCE_INTEGRITY_ERROR" });
    expect((await store.getHead("s", "t"))?.version).toBe(1);
  });

  it("applies body, metadata, and resource additions/overwrites/removals atomically", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut({ resourcesToWrite: [file("keep", "kept"), file("delete", "gone"), file("replace", "old")] }));
    const v2 = await versions.appendNextVersion(v1, ctx, mut({ content: "new body", metadata_json: '{"rev":2}', resourcesToWrite: [file("replace", "new"), file("add", "added")], resourcesToRemove: ["delete"] }));
    expect(v2.content).toBe("new body"); expect(v2.metadata_json).toBe('{"rev":2}');
    expect(v2.manifest.map(m => m.path).sort()).toEqual(["add", "keep", "replace"]);
    expect((await resources.readResource("s", 2, "replace", "utf-8", v2.storage_dir))?.content).toBe("new");
    expect((await resources.readResource("s", 1, "replace", "utf-8", v1.storage_dir))?.content).toBe("old");
  });

  it("concurrent losers cannot delete or overwrite the winner's resource directory", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut());
    const outcomes = await Promise.allSettled(["first", "second"].map(word => versions.appendNextVersion(v1, ctx, mut({ mutation_id: word, resourcesToWrite: [file("a", word)] }))));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const head = (await store.getHead("s", "t"))!;
    expect(head.storage_dir).not.toBe(resources.versionDir("s", 2));
    expect((await resources.readResource("s", 2, "a", "utf-8", head.storage_dir))?.content).toBe(head.mutation_id);
  });

  it("recovers a lost DB acknowledgement through mutation lookup without removing committed bytes", async () => {
    const append = store.appendVersion.bind(store);
    vi.spyOn(store, "appendVersion").mockImplementation(async input => { await append(input); throw new Error("lost response"); });
    const v1 = await versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "intent", resourcesToWrite: [file("a", "safe")] }));
    expect((await resources.readResource("s", 1, "a", "utf-8", v1.storage_dir))?.content).toBe("safe");
    const retry = await versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "intent", resourcesToWrite: [file("a", "safe")] }));
    expect(retry.row_id).toBe(v1.row_id);
    await expect(versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "intent", resourcesToWrite: [file("a", "evil")] }))).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
  });

  it("retains this attempt's directory when both commit and result lookup are unknown", async () => {
    const append = store.appendVersion.bind(store);
    vi.spyOn(store, "appendVersion").mockImplementation(async input => { await append(input); throw new Error("lost response"); });
    vi.spyOn(store, "getByMutationId").mockResolvedValueOnce(null).mockRejectedValue(new Error("offline"));
    await expect(versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "intent", resourcesToWrite: [file("a", "safe")] }))).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
    const row = (await store.getHead("s", "t"))!;
    expect(await storage.readFile(`${row.storage_dir}/files/a`)).toBe("safe");
  });

  it("simultaneous retries share one committed result and one usage delta", async () => {
    const delta = vi.fn();
    versions = new SkillVersioning({ store, storage, resources, onSkillVdbChanged: delta });
    const request = mut({ mutation_id: "same-intent", resourcesToWrite: [file("a", "safe")] });
    const [one, two] = await Promise.all([
      versions.createNewSkill("s", "a", ctx, request),
      versions.createNewSkill("s", "a", ctx, request),
    ]);
    expect(one.row_id).toBe(two.row_id);
    expect(await store.countVersions("s", "t")).toBe(1);
    expect(delta.mock.calls).toEqual([[1]]);
    expect(await storage.readFile(`${one.storage_dir}/files/a`)).toBe("safe");
  });

  it("cleans only the losing attempt when same intent races with a different payload", async () => {
    const outcomes = await Promise.allSettled(["first", "other"].map(content =>
      versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "collision", resourcesToWrite: [file("a", content)] }))));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason.code).toBe("SKILL_MUTATION_CONFLICT");
    const objects = await storage.getBackend().listObjects("skills/", { recursive: true });
    expect(objects.entries.filter(e => !e.isDirectory)).toHaveLength(1);
    const head = (await store.getHead("s", "t"))!;
    expect(await storage.readFile(`${head.storage_dir}/files/a`)).toBeTruthy();
  });

  it("preserves trusted coordinator rejection codes and cleans a fenced losing attempt", async () => {
    const rejected = Object.assign(new Error("coordinator fence lost"), { code: "SKILL_VERSION_STALE" });
    vi.spyOn(store, "appendVersion").mockRejectedValue(rejected);
    await expect(versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "fenced", resourcesToWrite: [file("a", "loser")] })))
      .rejects.toBe(rejected);
    expect(await store.getByMutationId("s", "fenced", "t")).toBeNull();
    const objects = await storage.getBackend().listObjects("skills/", { recursive: true });
    expect(objects.entries.filter(entry => !entry.isDirectory)).toHaveLength(0);
  });

  it("retains bytes for an independent coordinator UNKNOWN error even with an absent receipt", async () => {
    const unknown = Object.assign(new Error("coordinator result uncertain"), { code: "SKILL_PUBLICATION_UNKNOWN" });
    vi.spyOn(store, "appendVersion").mockRejectedValue(unknown);
    await expect(versions.createNewSkill("s", "a", ctx, mut({ mutation_id: "uncertain", resourcesToWrite: [file("a", "retain")] })))
      .rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
    const objects = await storage.getBackend().listObjects("skills/", { recursive: true });
    expect(objects.entries.filter(entry => !entry.isDirectory)).toHaveLength(1);
  });

  it("registers an asset only for the committed winner of same-name concurrent creates", async () => {
    const registered: Array<{ skill_id: string; committed: boolean }> = [];
    const hook = vi.fn(async ({ skill_id }: { skill_id: string }) => {
      registered.push({ skill_id, committed: !!(await store.getHead(skill_id, "t")) });
    });
    const delta = vi.fn();
    versions = new SkillVersioning({ store, storage, resources, onSkillCreated: hook, onSkillVdbChanged: delta });
    const outcomes = await Promise.allSettled(["left", "right"].map(sid => versions.createNewSkill(sid, "a", ctx,
      mut({ mutation_id: sid, resourcesToWrite: [file("a", sid)] }))));
    const fulfilled = outcomes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof versions.createNewSkill>>> => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(registered).toEqual([{ skill_id: fulfilled[0].value.skill_id, committed: true }]);
    expect(delta.mock.calls).toEqual([[1]]);
  });

  it("retains committed resources and retries failed asset registration through the same create receipt", async () => {
    const hook = vi.fn().mockRejectedValueOnce(new Error("metadata unavailable")).mockResolvedValue(undefined);
    const delta = vi.fn();
    versions = new SkillVersioning({ store, storage, resources, onSkillCreated: hook, onSkillVdbChanged: delta });
    const request = mut({ mutation_id: "asset-retry", resourcesToWrite: [file("a", "safe")] });
    await expect(versions.createNewSkill("s", "a", ctx, request)).rejects.toMatchObject({
      code: "SKILL_ASSET_REGISTRATION_PENDING", message: expect.stringContaining("skill_id=s"),
    });
    const committed = (await store.getByMutationId("s", "asset-retry", "t"))!;
    expect(committed).not.toBeNull();
    expect(await storage.readFile(`${committed.storage_dir}/files/a`)).toBe("safe");
    expect(await store.countVersions("s", "t")).toBe(1);
    expect(delta.mock.calls).toEqual([[1]]);
    const retry = await versions.createNewSkill("s", "a", ctx, request);
    expect(retry.row_id).toBe(committed.row_id);
    expect(await store.countVersions("s", "t")).toBe(1);
    expect(await storage.readFile(`${retry.storage_dir}/files/a`)).toBe("safe");
    expect(hook).toHaveBeenCalledTimes(2);
    expect(delta.mock.calls).toEqual([[1]]);
  });

  it("replays successful create registration idempotently without a second version or usage delta", async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const delta = vi.fn();
    versions = new SkillVersioning({ store, storage, resources, onSkillCreated: hook, onSkillVdbChanged: delta });
    const request = mut({ mutation_id: "asset-success" });
    const first = await versions.createNewSkill("s", "a", ctx, request);
    expect((await versions.createNewSkill("s", "a", ctx, request)).row_id).toBe(first.row_id);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(delta.mock.calls).toEqual([[1]]);
    expect(await store.countVersions("s", "t")).toBe(1);
  });

  it("rejects stale no-ops rather than returning an obsolete head", async () => {
    const v1 = await versions.createNewSkill("s", "a", ctx, mut());
    await versions.appendNextVersion(v1, ctx, mut({ content: "new" }));
    await expect(versions.appendNextVersion(v1, ctx, mut())).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });
});
