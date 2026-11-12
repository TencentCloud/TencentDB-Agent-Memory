import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { SkillCore } from "./skill-core.js";
import { SkillResourceStore, type SkillResourcePayload } from "./skill-resource-store.js";
import { SkillVersioning } from "./skill-versioning.js";

const ctx = { team_id: "team", agent_id: "owner", user_id: "user", task_id: "task" };
const skillId = "skl-package";
const content = (body = "Original body", extra = "") => `---\nname: package-guide\ndescription: Package guidance\n${extra}---\n\n${body}`;
const resource = (path: string, value: string): SkillResourcePayload => ({ path, content: value, encoding: "utf-8" });
const createInput = () => ({ ...ctx, skill_id: skillId, mutation_id: "create-intent", name: "package-guide", content: content(),
  resources: [resource("keep.txt", "keep"), resource("remove.txt", "remove")], metadata: { user_note: "retain", nested: { user: true } } });
const updateInput = () => ({ ...ctx, skill_id: skillId, expected_version: 1, mutation_id: "update-intent", content: content("Updated body"),
  resources: [resource("keep.txt", "changed"), { path: "bin/run", content: "AP+A", encoding: "base64" as const, mime_type: "application/x-package", is_executable: true }],
  metadata: { user_note: "retain", nested: { user: true }, service_note: "added" } });

describe("SkillCore complete packages (real SQLite and local storage)", () => {
  let root: string;
  let db: DatabaseSync;
  let store: SqliteSkillStore;
  let storage: StorageAdapter;
  let resources: SkillResourceStore;
  let versioning: SkillVersioning;
  let core: SkillCore;
  const registered = vi.fn(async (_entry: { skill_id: string }) => {});
  beforeEach(async () => {
    registered.mockClear();
    root = await mkdtemp(join(tmpdir(), "skill-package-core-"));
    db = new DatabaseSync(":memory:");
    store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();
    storage = new StorageAdapter(new LocalStorageBackend(root));
    resources = new SkillResourceStore({ storage });
    versioning = new SkillVersioning({ store, resources, storage, onSkillCreated: registered });
    core = new SkillCore({ store, resources, versioning });
  });
  afterEach(async () => { db?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("creates a stable id and replays the original receipt even after head advances", async () => {
    const input = createInput();
    const first = await core.createPackageVersion(input);
    const next = await core.applyPackageMutation(updateInput());
    expect(first.skill_id).toBe(skillId);
    expect(first.version).toBe(1);
    expect(next.version).toBe(2);
    const replay = await core.createPackageVersion(input);
    expect(replay.row_id).toBe(first.row_id);
    expect(registered).toHaveBeenCalledTimes(2);
    expect(registered.mock.calls.map(([entry]) => entry.skill_id)).toEqual([skillId, skillId]);
    expect(await store.countVersions(skillId, ctx.team_id)).toBe(2);
    await expect(core.createPackageVersion({ ...input, content: content("different") }))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
  });

  it("publishes body, full resource additions/removals, and metadata in exactly one version", async () => {
    const original = await core.createPackageVersion(createInput());
    const append = vi.spyOn(versioning, "appendNextVersion");
    const updated = await core.applyPackageMutation(updateInput());
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][2]).toMatchObject({ expected_version: 1, mutation_id: "update-intent", resourcesToRemove: ["remove.txt"] });
    expect(updated.version).toBe(2);
    expect(updated.content).toBe(content("Updated body"));
    expect(updated.manifest.map(entry => entry.path).sort()).toEqual(["bin/run", "keep.txt"]);
    expect(JSON.parse(updated.metadata_json)).toEqual(updateInput().metadata);
    expect(updated).toMatchObject({ name: original.name, team_id: original.team_id, owner_agent_id: original.owner_agent_id });
    expect(await store.countVersions(skillId, ctx.team_id)).toBe(2);
  });

  it("can inspect an oversized legacy source without permitting oversized publication", async () => {
    const large = content("x".repeat(50_100));
    await store.appendVersion({ ...ctx, skill_id: skillId, owner_agent_id: ctx.agent_id, name: "package-guide", description: "Package guidance",
      content: large, content_hash: createHash("md5").update(large).digest("hex"), manifest: [], storage_dir: resources.versionDir(skillId, 1) });
    expect((await core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).skill.content).toBe(large);
    await expect(core.applyPackageMutation({ ...updateInput(), content: large, resources: [] })).rejects.toMatchObject({ code: "SKILL_FRONTMATTER_INVALID" });
  });

  it("records the current writer's audit fields while retaining package ownership", async () => {
    await core.createPackageVersion(createInput());
    const updated = await core.applyPackageMutation({ ...updateInput(), user_id: "editor", task_id: "new-task" });
    expect(updated).toMatchObject({ owner_agent_id: ctx.agent_id, team_id: ctx.team_id, user_id: "editor", task_id: "new-task" });
  });

  it("can recover a committed mutation after its base version was collected", async () => {
    await core.createPackageVersion(createInput());
    const updated = await core.applyPackageMutation(updateInput());
    await store.deleteVersion(skillId, 1);
    const receipt = await core.lookupPackageMutation({ ...ctx, skill_id: skillId, mutation_id: "update-intent" });
    expect(receipt?.row_id).toBe(updated.row_id);
    await expect(core.lookupPackageMutation({ ...ctx, team_id: "foreign", skill_id: skillId, mutation_id: "update-intent" })).resolves.toBeNull();
  });

  it("returns an entire verified package with binary bytes, MIME and executable flags", async () => {
    await core.createPackageVersion(createInput());
    const updated = await core.applyPackageMutation(updateInput());
    const result = await core.readPackage({ ...ctx, skill_id: skillId, expected_version: 2 });
    expect(result.skill.row_id).toBe(updated.row_id);
    expect(result.resources).toHaveLength(2);
    expect(result.resources.find(entry => entry.path === "bin/run")).toEqual({
      path: "bin/run", content: "AP+A", encoding: "base64", mime_type: "application/x-package", is_executable: true,
    });
    expect(Buffer.from(result.resources.find(entry => entry.path === "keep.txt")!.content, "base64").toString()).toBe("changed");
  });

  it("preserves user metadata when omitted and preserves an intentionally empty resource set", async () => {
    await core.createPackageVersion(createInput());
    const { metadata: _metadata, ...input } = updateInput();
    const result = await core.applyPackageMutation({ ...input, resources: [] });
    expect(JSON.parse(result.metadata_json)).toEqual(createInput().metadata);
    expect(result.manifest).toEqual([]);
  });

  it("replays an update against its original base after a newer head changes resources and metadata", async () => {
    await core.createPackageVersion(createInput());
    const input = updateInput();
    const original = await core.applyPackageMutation(input);
    await core.applyPackageMutation({ ...input, mutation_id: "third", expected_version: 2, content: content("Third body"), resources: [], metadata: { third: true } });
    const replay = await core.applyPackageMutation(input);
    expect(replay.row_id).toBe(original.row_id);
    expect(await store.countVersions(skillId, ctx.team_id)).toBe(3);
    await expect(core.applyPackageMutation({ ...input, resources: [resource("different", "bad")] }))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    await expect(core.applyPackageMutation({ ...input, mutation_id: "new-stale" }))
      .rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });

  it("checks team and owner before serving a successful mutation replay", async () => {
    const input = createInput();
    await core.createPackageVersion(input);
    await core.applyPackageMutation(updateInput());
    for (const foreign of [{ team_id: "other-team" }, { agent_id: "other-owner" }]) {
      const code = "team_id" in foreign ? "SKILL_NOT_FOUND" : "SKILL_NOT_OWNER";
      await expect(core.createPackageVersion({ ...input, ...foreign })).rejects.toMatchObject({ code });
      await expect(core.applyPackageMutation({ ...updateInput(), ...foreign })).rejects.toMatchObject({ code });
      await expect(core.readPackage({ ...ctx, ...foreign, skill_id: skillId, expected_version: 2 })).rejects.toMatchObject({ code });
    }
  });

  it("does not overwrite a different skill or silently change its name", async () => {
    await core.createPackageVersion(createInput());
    await expect(core.createPackageVersion({ ...createInput(), mutation_id: "other-create" }))
      .rejects.toMatchObject({ code: "SKILL_ID_COLLISION" });
    await expect(core.createPackageVersion({ ...createInput(), skill_id: "skl-other" }))
      .rejects.toMatchObject({ code: "SKILL_NAME_DUPLICATE" });
    await expect(core.applyPackageMutation({ ...updateInput(), content: content().replace("name: package-guide", "name: renamed") }))
      .rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    expect((await store.getHead(skillId, ctx.team_id))?.version).toBe(1);
  });

  it("never re-registers or republishes a deleted create/update intent", async () => {
    const input = createInput();
    await core.createPackageVersion(input);
    await core.applyPackageMutation(updateInput());
    await core.delete({ ...ctx, skill_id: skillId });
    expect(await store.getByMutationId(skillId, input.mutation_id, ctx.team_id)).not.toBeNull();
    await expect(core.createPackageVersion(input)).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(core.applyPackageMutation(updateInput())).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(registered).toHaveBeenCalledTimes(1);
    expect(await store.getHead(skillId, ctx.team_id)).toBeNull();
  });

  it("keeps ordinary history reads and exports on their actual attempt directories", async () => {
    const first = await core.createPackageVersion(createInput());
    const second = await core.applyPackageMutation(updateInput());
    expect(first.storage_dir).toContain("/attempts/");
    expect(second.storage_dir).not.toBe(first.storage_dir);
    expect((await core.readFile({ ...ctx, skill_id: skillId, version: 1, path: "keep.txt" })).content).toBe("keep");
    expect((await core.readFile({ ...ctx, skill_id: skillId, version: 2, path: "keep.txt" })).content).toBe("changed");
    const exported = await core.exportSkill({ ...ctx, skill_id: skillId, version: 1 });
    expect(exported.warnings).toEqual([]);
    const zip = unzipSync(Buffer.from(exported.zip_base64, "base64"));
    expect(strFromU8(zip["package-guide/keep.txt"])).toBe("keep");
    expect(strFromU8(zip["package-guide/SKILL.md"])).toBe(content());
  });

  it("continues to read legacy resource directories", async () => {
    const manifest = [await resources.writeResource(skillId, 1, resource("legacy.txt", "legacy"))];
    await store.appendVersion({ ...ctx, skill_id: skillId, owner_agent_id: ctx.agent_id, name: "package-guide", description: "Package guidance", content: content(), content_hash: "legacy", manifest, storage_dir: resources.versionDir(skillId, 1) });
    expect((await core.readFile({ ...ctx, skill_id: skillId, path: "legacy.txt" })).content).toBe("legacy");
    expect((await core.exportSkill({ ...ctx, skill_id: skillId })).warnings).toEqual([]);
  });

  it("rejects incomplete, truncated or hash-corrupt resource snapshots rather than returning partial data", async () => {
    const row = await core.createPackageVersion(createInput());
    const path = `${row.storage_dir}/files/keep.txt`;
    for (const bad of ["K", "evil"]) {
      await storage.writeFile(path, bad);
      await expect(core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).rejects.toMatchObject({ code: "RESOURCE_INTEGRITY_ERROR" });
    }
    await storage.unlink(path);
    await expect(core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).rejects.toMatchObject({ code: "RESOURCE_INTEGRITY_ERROR" });
    expect(row.manifest.find(entry => entry.path === "keep.txt")?.content_sha256).toBe(createHash("sha256").update("keep").digest("hex"));
  });

  it("permits only one competing package update at the same expected revision", async () => {
    await core.createPackageVersion(createInput());
    const outcomes = await Promise.allSettled(["one", "two"].map(mutation_id =>
      core.applyPackageMutation({ ...updateInput(), mutation_id, content: content(mutation_id) })));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((outcomes.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe("SKILL_VERSION_STALE");
    expect(await store.countVersions(skillId, ctx.team_id)).toBe(2);
    const current = (await store.getHead(skillId, ctx.team_id))!;
    expect((await core.readPackage({ ...ctx, skill_id: skillId, expected_version: 2 })).skill.row_id).toBe(current.row_id);
  });

  it("shares a single durable create receipt for concurrent retries", async () => {
    const [one, two] = await Promise.all([core.createPackageVersion(createInput()), core.createPackageVersion(createInput())]);
    expect(one.row_id).toBe(two.row_id);
    expect(await store.countVersions(skillId, ctx.team_id)).toBe(1);
    expect((await core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).resources).toHaveLength(2);
  });

  it("replays omitted metadata using the original base rather than the advanced head", async () => {
    await core.createPackageVersion(createInput());
    const { metadata: _metadata, ...input } = updateInput();
    const second = await core.applyPackageMutation(input);
    await core.applyPackageMutation({ ...updateInput(), expected_version: 2, mutation_id: "third", metadata: { only: "third" } });
    expect((await core.applyPackageMutation(input)).row_id).toBe(second.row_id);
    expect(JSON.parse((await store.getHead(skillId, ctx.team_id))!.metadata_json)).toEqual({ only: "third" });
  });

  it("treats a present but invalid manifest hash as corruption, while allowing legacy missing hashes", async () => {
    const row = await core.createPackageVersion(createInput());
    const manifest = row.manifest.map(entry => ({ ...entry, content_sha256: "" }));
    db.prepare("UPDATE skills SET manifest_json=? WHERE row_id=?").run(JSON.stringify(manifest), row.row_id);
    await expect(core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).rejects.toMatchObject({ code: "RESOURCE_INTEGRITY_ERROR" });
    db.prepare("UPDATE skills SET manifest_json=? WHERE row_id=?").run(JSON.stringify(row.manifest.map(({ content_sha256: _hash, ...entry }) => entry)), row.row_id);
    expect((await core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).resources).toHaveLength(2);
  });

  it("rejects stale semantic reads rather than returning a mixed head/history package", async () => {
    await core.createPackageVersion(createInput());
    await core.applyPackageMutation(updateInput());
    await expect(core.readPackage({ ...ctx, skill_id: skillId, expected_version: 1 })).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });

  it.each([
    ["metadata protected", { protected: true }, ""],
    ["metadata pinned", { pinned: true }, ""],
    ["external-managed", { managed_by: "external" }, ""],
    ["frontmatter protected", {}, "protected: true # YAML boolean\n"],
    ["frontmatter pinned alias", {}, "guard: &guard true\npinned: *guard\n"],
  ])("rejects %s only for semantic package operations", async (_name, metadata, frontmatter) => {
    const ordinary = await core.create({ ...ctx, name: "package-guide", content: content("Protected", frontmatter), resources: [resource("readable", "still readable")], metadata });
    const input = { ...ctx, skill_id: ordinary.skill_id, expected_version: 1 };
    await expect(core.readPackage(input)).rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    await expect(core.applyPackageMutation({ ...updateInput(), ...input })).rejects.toMatchObject({ code: "SKILL_PROTECTED" });
    expect((await core.get({ ...ctx, skill_id: ordinary.skill_id })).row_id).toBe(ordinary.row_id);
    expect((await core.readFile({ ...ctx, skill_id: ordinary.skill_id, path: "readable" })).content).toBe("still readable");
  });

  it("does not mistake quoted false/true strings or body text for YAML boolean guards", async () => {
    const row = await core.createPackageVersion({ ...createInput(), content: content("protected: true is documentation", 'protected: "true"\npinned: false\n'), metadata: { protected: "true", pinned: false } });
    expect((await core.readPackage({ ...ctx, skill_id: row.skill_id, expected_version: 1 })).skill.row_id).toBe(row.row_id);
  });

  it("rejects malformed stable ids, empty identity fields, duplicate resource paths and invalid expected versions", async () => {
    for (const override of [{ skill_id: "../escape" }, { skill_id: "" }, { mutation_id: " " }, { team_id: "" }, { agent_id: "" }]) {
      await expect(core.createPackageVersion({ ...createInput(), ...override })).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    }
    await core.createPackageVersion(createInput());
    await expect(core.applyPackageMutation({ ...updateInput(), resources: [resource("same", "a"), resource("same", "b")] }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    for (const expected_version of [0, -1, 1.5, Number.NaN]) {
      await expect(core.readPackage({ ...ctx, skill_id: skillId, expected_version })).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
      await expect(core.applyPackageMutation({ ...updateInput(), expected_version })).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    }
  });
});
