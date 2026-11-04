import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { StorageAdapter } from "../storage/adapter.js";
import { SkillResourceStore } from "./skill-resource-store.js";
import { SkillVersioning } from "./skill-versioning.js";
import { SkillCore } from "./skill-core.js";
import { GitHubSkillManager } from "./github-manager.js";
import { bundleDigest, type GitHubSnapshot } from "./github-source.js";
const ctx = { team_id: "team-a", agent_id: "agent-a", user_id: "user-a" };
const location = {
  repository: "https://github.com/example/skills",
  ref: "main",
  path: "demo",
};
function snapshot(revision = "a", guide = "old"): GitHubSnapshot {
  const content =
    "---\nname: demo\ndescription: Demo skill\n---\nRead guide.md";
  const resources = [
    { path: "guide.md", content: guide, encoding: "utf-8" as const },
  ];
  return {
    content,
    resources,
    source: {
      ...location,
      commit: revision.repeat(40),
      digest: bundleDigest(content, resources),
      checked_at: new Date().toISOString(),
    },
  };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "github-skill-"));
  const db = new DatabaseSync(":memory:");
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new SqliteSkillStore({ db, dimensions: 0 });
  store.init();
  const backend = new LocalStorageBackend(dir);
  const storage = new StorageAdapter(backend);
  const resources = new SkillResourceStore({ storage });
  const versioning = new SkillVersioning({ store, resources, storage });
  const core = new SkillCore({ store, resources, versioning });
  const fetcher = vi.fn(async () => snapshot());
  const manager = new GitHubSkillManager({
    store,
    resources,
    versioning,
    fetcher,
  });
  async function install() {
    const preview = await manager.preview({ ...ctx, ...location });
    return manager.apply({
      ...ctx,
      ...location,
      expected_version: 0,
      commit: preview.source.commit,
      digest: preview.source.digest,
    });
  }
  return {
    db,
    store,
    backend,
    core,
    manager,
    fetcher,
    install,
    storage,
    resources,
    versioning,
  };
}
describe("GitHub Skill publication with SQLite and filesystem storage", () => {
  it("previews without writes and makes repeated/concurrent installation idempotent", async () => {
    const f = await fixture();
    await f.manager.preview({ ...ctx, ...location });
    expect((await f.store.listSkills({ team_id: ctx.team_id })).total).toBe(0);
    const rows = await Promise.all([f.install(), f.install(), f.install()]);
    expect(new Set(rows.map((r) => r.skill_id)).size).toBe(1);
    expect(rows.map((r) => r.version)).toEqual([1, 1, 1]);
    expect(await f.store.countVersions(rows[0].skill_id, ctx.team_id)).toBe(1);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: rows[0].skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
  });
  it("upgrades attachment-only changes, preserves history and refuses unseen local edits", async () => {
    const f = await fixture();
    const row = await f.install();
    f.fetcher.mockResolvedValue(snapshot("b", "new"));
    const preview = await f.manager.preview({ ...ctx, skill_id: row.skill_id });
    expect(preview.files.changed).toEqual(["guide.md"]);
    await f.core.update({
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      content: row.content + "\nlocal",
    });
    const apply = {
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      commit: preview.source.commit,
      digest: preview.source.digest,
    };
    await expect(f.manager.apply(apply)).rejects.toMatchObject({
      code: "SKILL_VERSION_STALE",
    });
    const conflict = await f.manager.preview({
      ...ctx,
      skill_id: row.skill_id,
    });
    expect(conflict.local_modified).toBe(true);
    await expect(
      f.manager.apply({ ...apply, expected_version: 2 }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    const upgraded = await f.manager.apply({
      ...apply,
      expected_version: 2,
      overwrite_local: true,
    });
    expect(upgraded.version).toBe(3);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("new");
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          version: 1,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
  });
  it("retains the old head on storage failure and can retry successfully", async () => {
    const f = await fixture();
    const row = await f.install();
    f.fetcher.mockResolvedValue(snapshot("b", "new"));
    const p = await f.manager.preview({ ...ctx, skill_id: row.skill_id });
    const input = {
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      commit: p.source.commit,
      digest: p.source.digest,
    };
    const put = vi
      .spyOn(f.backend, "putObject")
      .mockRejectedValueOnce(new Error("interrupted"));
    await expect(f.manager.apply(input)).rejects.toThrow("interrupted");
    expect((await f.store.getHead(row.skill_id, ctx.team_id))?.version).toBe(1);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
    put.mockRestore();
    expect((await f.manager.apply(input)).version).toBe(2);
  });
  it("rejects cross-team and non-owner updates before contacting GitHub", async () => {
    const f = await fixture();
    const row = await f.install();
    f.fetcher.mockClear();
    await expect(
      f.manager.preview({ ...ctx, team_id: "team-b", skill_id: row.skill_id }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(
      f.manager.preview({ ...ctx, agent_id: "other", skill_id: row.skill_id }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_OWNER" });
    expect(f.fetcher).not.toHaveBeenCalled();
    const other = await f.manager.apply({
      ...ctx,
      team_id: "team-b",
      ...location,
      expected_version: 0,
      commit: snapshot().source.commit,
      digest: snapshot().source.digest,
    });
    expect(other.skill_id).not.toBe(row.skill_id);
  });
  it("rejects a changed preview digest without writing and pins apply to the preview commit", async () => {
    const f = await fixture();
    const p = await f.manager.preview({ ...ctx, ...location });
    f.fetcher.mockResolvedValue(snapshot("b", "moved branch"));
    await expect(
      f.manager.apply({
        ...ctx,
        ...location,
        expected_version: 0,
        commit: p.source.commit,
        digest: p.source.digest,
      }),
    ).rejects.toThrow("Preview differs");
    expect(f.fetcher).toHaveBeenLastCalledWith({
      ...location,
      ref: p.source.commit,
    });
    expect((await f.store.listSkills({ team_id: ctx.team_id })).total).toBe(0);
  });
  it("publishes only one concurrent upgrade across independent store instances and preserves winner resources", async () => {
    const f = await fixture();
    const row = await f.install();
    const otherStore = new SqliteSkillStore({ db: f.db, dimensions: 0 });
    const other = new GitHubSkillManager({
      store: otherStore,
      resources: f.resources,
      versioning: new SkillVersioning({
        store: otherStore,
        resources: f.resources,
        storage: f.storage,
      }),
      fetcher: async () => snapshot("c", "other writer"),
    });
    f.fetcher.mockResolvedValue(snapshot("b", "first writer"));
    const input = { ...ctx, skill_id: row.skill_id, expected_version: 1 };
    const results = await Promise.allSettled([
      f.manager.apply({
        ...input,
        commit: snapshot("b", "first writer").source.commit,
        digest: snapshot("b", "first writer").source.digest,
      }),
      other.apply({
        ...input,
        commit: snapshot("c", "other writer").source.commit,
        digest: snapshot("c", "other writer").source.digest,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "SKILL_VERSION_STALE" },
    });
    const winner = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof f.install>>
      >
    ).value;
    const source = JSON.parse(winner.metadata_json).github_source;
    const resource = await f.core.readFile({
      ...ctx,
      skill_id: row.skill_id,
      path: "guide.md",
    });
    expect(resource.content).toBe(
      source.commit.startsWith("b") ? "first writer" : "other writer",
    );
    expect(await f.store.countVersions(row.skill_id, ctx.team_id)).toBe(2);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          version: 1,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
  });
  it("detaches without losing local edits or historical provenance", async () => {
    const f = await fixture();
    const row = await f.install();
    await f.core.writeFiles({
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      files: [{ path: "guide.md", content: "local", encoding: "utf-8" }],
    });
    const detached = await f.manager.detach({
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 2,
    });
    expect(JSON.parse(detached.metadata_json).github_source).toBeUndefined();
    expect(
      JSON.parse(
        (await f.store.getByVersion(row.skill_id, 1, ctx.team_id))!
          .metadata_json,
      ).github_source.commit,
    ).toBe("a".repeat(40));
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("local");
    await expect(
      f.manager.preview({ ...ctx, skill_id: row.skill_id }),
    ).rejects.toThrow("not linked");
  });
  it("recovers a committed publication whose database acknowledgment was lost", async () => {
    const f = await fixture();
    const append = f.store.appendVersion.bind(f.store);
    vi.spyOn(f.store, "appendVersion").mockImplementationOnce(async (input) => {
      await append(input);
      throw new Error("lost acknowledgment");
    });
    const row = await f.install();
    expect(row.version).toBe(1);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
    expect((await f.install()).version).toBe(1);
  });

  it("removes deleted upstream files atomically while retaining historical resources and exports", async () => {
    const f = await fixture();
    const row = await f.install();
    const next = snapshot("b");
    next.resources = [];
    next.source.digest = bundleDigest(next.content, []);
    f.fetcher.mockResolvedValue(next);
    const p = await f.manager.preview({ ...ctx, skill_id: row.skill_id });
    expect(p.files.removed).toEqual(["guide.md"]);
    const updated = await f.manager.apply({
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      commit: p.source.commit,
      digest: p.source.digest,
    });
    expect(updated.manifest).toEqual([]);
    await expect(
      f.core.readFile({ ...ctx, skill_id: row.skill_id, path: "guide.md" }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    const archive = await f.core.exportSkill({
      ...ctx,
      skill_id: row.skill_id,
      version: 1,
    });
    expect(archive.file_count).toBe(1);
    expect(archive.warnings).toEqual([]);
  });
  it("does not charge quota again for an already committed installation", async () => {
    const f = await fixture();
    const row = await f.install();
    const quota = vi.fn(async () => {
      throw new Error("quota full");
    });
    const result = await f.manager.apply(
      {
        ...ctx,
        ...location,
        expected_version: 0,
        commit: snapshot().source.commit,
        digest: snapshot().source.digest,
      },
      quota,
    );
    expect(result.skill_id).toBe(row.skill_id);
    expect(quota).not.toHaveBeenCalled();
  });
  it("retries asset registration after publication without creating another version", async () => {
    const f = await fixture();
    const asset = vi
      .fn()
      .mockRejectedValueOnce(new Error("asset registry unavailable"))
      .mockResolvedValue(undefined);
    const manager = new GitHubSkillManager({
      store: f.store,
      resources: f.resources,
      fetcher: f.fetcher,
      versioning: new SkillVersioning({
        store: f.store,
        resources: f.resources,
        storage: f.storage,
        onSkillCreated: asset,
      }),
    });
    const input = {
      ...ctx,
      ...location,
      expected_version: 0,
      commit: snapshot().source.commit,
      digest: snapshot().source.digest,
    };
    await expect(manager.apply(input)).rejects.toThrow(
      "asset registry unavailable",
    );
    const row = await manager.apply(input);
    expect(row.version).toBe(1);
    expect(asset).toHaveBeenCalledTimes(2);
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("old");
  });
  it("does not let a stale normal edit delete published files on prefix-based object storage", async () => {
    const f = await fixture();
    const row = await f.install();
    // COS-style prefixes are lexical, unlike filesystem directory deletion.
    vi.spyOn(f.backend, "deleteByPrefix").mockImplementation(async (prefix) => {
      const entries = await f.backend.listObjects("skills/", {
        recursive: true,
        maxKeys: 1000,
      });
      const targets = entries.entries.filter(
        (entry) => !entry.isDirectory && entry.key.startsWith(prefix),
      );
      for (const entry of targets) await f.backend.deleteObject(entry.key);
      return targets.length;
    });
    const next = snapshot("b", "published");
    f.fetcher.mockResolvedValue(next);
    await f.manager.apply({
      ...ctx,
      skill_id: row.skill_id,
      expected_version: 1,
      commit: next.source.commit,
      digest: next.source.digest,
    });
    await expect(
      f.versioning.appendNextVersion(row, ctx, {
        content: row.content + "\nmanual",
        name: row.name,
        description: row.description,
      }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    expect(
      (
        await f.core.readFile({
          ...ctx,
          skill_id: row.skill_id,
          path: "guide.md",
        })
      ).content,
    ).toBe("published");
  });
});
