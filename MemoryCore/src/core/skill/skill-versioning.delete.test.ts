import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillResourceStore } from "./skill-resource-store.js";
import type { ISkillStore } from "./skill-store.interface.js";
import { SkillVersioning } from "./skill-versioning.js";
import type { Skill } from "./types.js";

function makeVersions(offset: number, count: number): Skill[] {
  return Array.from({ length: count }, (_, index) => {
    const version = offset + index + 1;
    return {
      skill_id: "skill-1",
      version,
      is_head: version === 1,
      storage_dir: `skills/skill-1/v${version}`,
    } as Skill;
  });
}

function makeDescendingVersions(from: number, count: number, headVersion: number): Skill[] {
  return Array.from({ length: count }, (_, index) => {
    const version = from - index;
    return {
      skill_id: "skill-1",
      version,
      is_head: version === headVersion,
      status: "active",
      storage_dir: `skills/skill-1/v${version}`,
      created_at_ms: version,
    } as Skill;
  });
}

describe("SkillVersioning.deleteSkill storage cleanup", () => {
  it("collects every version page before deleting all database rows", async () => {
    const listVersions = vi.fn(async (_skillId: string, _teamId?: string, page?: { limit?: number; offset?: number }) => {
      const offset = page?.offset ?? 0;
      if (offset === 0) return makeVersions(0, 1_000);
      if (offset === 1_000) return makeVersions(1_000, 500);
      return [];
    });
    const deleteAllVersions = vi.fn().mockResolvedValue(1_500);
    const store = {
      listVersions,
      deleteAllVersions,
    } as unknown as ISkillStore;
    const rmdir = vi.fn().mockResolvedValue(undefined);
    const storage = { rmdir } as unknown as StorageAdapter;
    const onSkillVdbChanged = vi.fn();
    const versioning = new SkillVersioning({
      store,
      resources: {} as SkillResourceStore,
      storage,
      onSkillVdbChanged,
    });

    await expect(versioning.deleteSkill("skill-1", "team-1")).resolves.toBe(1_500);

    expect(listVersions).toHaveBeenNthCalledWith(
      1,
      "skill-1",
      "team-1",
      { limit: 1_000, offset: 0 },
    );
    expect(listVersions).toHaveBeenNthCalledWith(
      2,
      "skill-1",
      "team-1",
      { limit: 1_000, offset: 1_000 },
    );
    expect(rmdir).toHaveBeenCalledTimes(1_500);
    expect(rmdir).toHaveBeenNthCalledWith(1, "skills/skill-1/v1");
    expect(rmdir).toHaveBeenNthCalledWith(1_500, "skills/skill-1/v1500");
    expect(onSkillVdbChanged).toHaveBeenCalledWith(-1_500);
  });

  it("cleans versions beyond the first list page by maxNonHeadVersions", async () => {
    const listVersions = vi.fn(async (_skillId: string, _teamId?: string, page?: { limit?: number; offset?: number }) => {
      const offset = page?.offset ?? 0;
      if (offset === 0) return makeDescendingVersions(1_500, 1_000, 1_500);
      if (offset === 1_000) return makeDescendingVersions(500, 500, 1_500);
      return [];
    });
    const deleteVersion = vi.fn().mockResolvedValue(true);
    const store = {
      listVersions,
      deleteVersion,
    } as unknown as ISkillStore;
    const rmdir = vi.fn().mockResolvedValue(undefined);
    const storage = { rmdir } as unknown as StorageAdapter;
    const versioning = new SkillVersioning({
      store,
      resources: {} as SkillResourceStore,
      storage,
    });

    await versioning.cleanupExpiredVersionsForSkill("skill-1", 0, 100);

    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(deleteVersion).toHaveBeenCalledTimes(1_399);
    expect(rmdir).toHaveBeenCalledTimes(1_399);
  });
});
