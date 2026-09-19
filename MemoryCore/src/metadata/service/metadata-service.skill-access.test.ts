/**
 * MetadataService.recordSkillAccess —— skill 读命中审计（issue #1189）。
 *
 * 验证 `onSkillAccessed` 钩子统一落地点的两步语义：
 *   1. 孤儿 skill 读时自愈补登记（asset + agent 绑定）
 *   2. `meta_assets.usage_count += 1` / `last_used_at = now`，且每次读命中都累加
 *      （不被 ensureSkillAsset 的 LRU 短路吞掉）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import { SkillCore } from "../../core/skill/skill-core.js";
import type { Skill } from "../../core/skill/types.js";

async function seed() {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const svc = new MetadataService(store, "test-instance");
  const user = await store.createUser({ auth_provider: "local", external_id: "u1", username: "u1" });
  const team = await store.createTeam({ name: "T", owner_user_id: user.user_id });
  const agent = await store.createAgent({ team_id: team.team_id, owner_user_id: user.user_id, name: "A" });
  return { store, svc, user, team, agent };
}

describe("MetadataService.recordSkillAccess", () => {
  let ctx: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    ctx = await seed();
  });

  it("首次读命中：自愈补登记 asset 并 usage_count=1 / last_used_at 非空", async () => {
    const params = { skill_id: "skl-access000001", team_id: ctx.team.team_id, agent_id: ctx.agent.agent_id, name: "demo" };
    expect(await ctx.store.getAssetById(params.skill_id)).toBeNull();

    const asset = await ctx.svc.recordSkillAccess(params);

    expect(asset.asset_id).toBe(params.skill_id);
    const got = await ctx.store.getAssetById(params.skill_id);
    expect(got?.asset_type).toBe("skill");
    expect(got?.usage_count).toBe(1);
    expect(got?.last_used_at).toBeTruthy();
    const bound = await ctx.store.listAgentFixedAssets(ctx.agent.agent_id, { limit: 10, offset: 0 });
    expect(bound.items.map((b) => b.asset_id)).toContain(params.skill_id);
  });

  it("重复读命中：即使 ensureSkillAsset 走 LRU 短路，usage_count 仍每次 +1", async () => {
    const params = { skill_id: "skl-access000002", team_id: ctx.team.team_id, agent_id: ctx.agent.agent_id, name: "demo" };
    await ctx.svc.recordSkillAccess(params);
    const first = await ctx.store.getAssetById(params.skill_id);
    await ctx.svc.recordSkillAccess(params);
    await ctx.svc.recordSkillAccess(params);

    const got = await ctx.store.getAssetById(params.skill_id);
    expect(got?.usage_count).toBe(3);
    expect(got?.last_used_at! >= first!.last_used_at!).toBe(true);
  });

  it("agent 不存在时抛错且不落任何 asset（调用方 fire-and-forget 吞掉）", async () => {
    const params = { skill_id: "skl-access000003", team_id: ctx.team.team_id, agent_id: "agent-missing", name: "demo" };
    await expect(ctx.svc.recordSkillAccess(params)).rejects.toThrow(/agent .* not found/);
    expect(await ctx.store.getAssetById(params.skill_id)).toBeNull();
  });
});

/**
 * SkillCore 侧：哪些读接口触发 onSkillAccessed。
 * 用最小 stub store 验证「get / readFile 命中 → 触发；list / search / 未命中 → 不触发」，
 * 保证 usage 计数只在真实读命中时发生（避免写放大）。
 */
describe("SkillCore.onSkillAccessed 触发面", () => {
  const skill: Skill = {
    skill_id: "skl-core00000001",
    team_id: "team-1",
    owner_agent_id: "agent-1",
    name: "demo",
    description: "d",
    version: 1,
    status: "active",
    content: "---\nname: demo\ndescription: d\n---\nbody",
    manifest: [{ path: "SKILL.md", size_bytes: 4, sha256: "x", mime_type: "text/markdown" }],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  } as unknown as Skill;

  function makeCore(accessed: Skill[]) {
    const store = {
      getHead: async (id: string) => (id === skill.skill_id ? skill : null),
      getByVersion: async () => skill,
      listSkills: async () => ({ items: [skill], total: 1 }),
      searchSkills: async () => [{ skill, score: 1 }],
      listVersions: async () => [skill],
      countVersions: async () => 1,
    };
    const resources = {
      readResource: async () => ({ path: "SKILL.md", content: "body", encoding: "utf-8", size_bytes: 4, mime_type: "text/markdown" }),
    };
    return new SkillCore({
      store: store as never,
      resources: resources as never,
      versioning: {} as never,
      onSkillAccessed: (s) => { accessed.push(s); },
    });
  }

  it("get / readFile 命中各触发一次；list / search 不触发", async () => {
    const accessed: Skill[] = [];
    const core = makeCore(accessed);

    await core.get({ skill_id: skill.skill_id, team_id: "team-1" });
    expect(accessed).toHaveLength(1);

    await core.readFile({ skill_id: skill.skill_id, team_id: "team-1", path: "SKILL.md" });
    expect(accessed).toHaveLength(2);

    await core.list({ team_id: "team-1" });
    await core.search({ team_id: "team-1", query: "demo" });
    expect(accessed).toHaveLength(2);
    expect(accessed.every((s) => s.skill_id === skill.skill_id)).toBe(true);
  });

  it("get 未命中（SKILL_NOT_FOUND）不触发", async () => {
    const accessed: Skill[] = [];
    const core = makeCore(accessed);
    await expect(core.get({ skill_id: "skl-nope", team_id: "team-1" })).rejects.toThrow();
    expect(accessed).toHaveLength(0);
  });

  it("钩子抛异常不影响 get 返回", async () => {
    const core = new SkillCore({
      store: { getHead: async () => skill } as never,
      resources: {} as never,
      versioning: {} as never,
      onSkillAccessed: () => { throw new Error("boom"); },
    });
    await expect(core.get({ skill_id: skill.skill_id })).resolves.toMatchObject({ skill_id: skill.skill_id });
  });
});
