/**
 * Regression test for #1189: `usage_count` / `last_used_at` on `meta_assets`
 * were never updated when a skill was read via `handleGet`, because the read
 * path never called `MetadataService.touchAssetUsage()` — unlike the create
 * path, which registers the asset via `ensureSkillAsset()`.
 */
import { describe, it, expect, vi } from "vitest";

import { handleGet } from "../skill-handlers.js";
import type { SkillRouterDeps } from "../skill-handlers.js";
import type { V2AuthContext } from "../v2-schemas.js";
import type { Skill } from "../../core/skill/types.js";
import type { SkillCore } from "../../core/skill/skill-core.js";

const AUTH: V2AuthContext = { apiKey: "test", serviceId: "dev-1" };

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    skill_id: "skl-test1",
    name: "code-review",
    description: "test skill",
    version: 1,
    is_head: true,
    status: "active",
    user_id: "usr-1",
    owner_agent_id: "agt-1",
    team_id: "team-1",
    task_id: "default",
    created_at_ms: 0,
    updated_at_ms: 0,
    metadata_json: "{}",
    content: "# hi",
    content_hash: undefined,
    storage_dir: undefined,
    manifest: undefined,
    ...overrides,
  } as unknown as Skill;
}

function makeDeps(opts: {
  skill?: Skill;
  touchAssetUsage?: ReturnType<typeof vi.fn>;
  withMetadataService?: boolean;
}): SkillRouterDeps {
  const skill = opts.skill ?? makeSkill();
  const core = {
    get: vi.fn().mockResolvedValue(skill),
  } as unknown as SkillCore;

  const deps: SkillRouterDeps = {
    getSkillCore: () => core,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  if (opts.withMetadataService !== false) {
    const touchAssetUsage = opts.touchAssetUsage ?? vi.fn().mockResolvedValue(undefined);
    deps.getMetadataService = vi.fn().mockResolvedValue({ touchAssetUsage });
  }

  return deps;
}

describe("handleGet — usage tracking (#1189)", () => {
  it("calls touchAssetUsage with the skill_id after a successful read", async () => {
    const touchAssetUsage = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ touchAssetUsage });

    const res = await handleGet({ skill_id: "skl-test1" }, AUTH, "req-1", deps);

    expect(res.code).toBe(0);
    expect(touchAssetUsage).toHaveBeenCalledTimes(1);
    expect(touchAssetUsage).toHaveBeenCalledWith("skl-test1");
  });

  it("still returns the skill successfully even if touchAssetUsage fails", async () => {
    const touchAssetUsage = vi.fn().mockRejectedValue(new Error("boom"));
    const deps = makeDeps({ touchAssetUsage });

    const res = await handleGet({ skill_id: "skl-test1" }, AUTH, "req-2", deps);

    expect(res.code).toBe(0);
    expect((res as { data?: { skill_id?: string } }).data?.skill_id).toBe("skl-test1");
    expect(touchAssetUsage).toHaveBeenCalledTimes(1);
  });
});