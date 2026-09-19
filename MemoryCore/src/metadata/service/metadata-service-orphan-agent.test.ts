/**
 * Bug #1321 —— 成员移除 / 用户删除后的「孤儿 Agent」回归测试。
 *
 * 覆盖三条缺陷链的修复：
 *   1. removeTeamMemberForCaller 级联硬删除该成员在团队名下的 Agent
 *   2. deleteUsersForCaller     级联硬删除该用户名下所有 team 的 Agent
 *   3. deleteAgentsForCaller / archiveAgentForCaller 权限面放宽为
 *      owner / team admin / system_admin（与 createAgentForCaller 对称）
 *
 * 断言口径：级联后 metadata 表（meta_agents / meta_task_agents /
 * meta_agent_fixed_assets / meta_assets）中不留悬空行。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetadataService } from "./metadata-service.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { newExternalAssetId } from "../utils/external-asset-id.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import type { V3AuthContext } from "../router/auth.js";
import type { AgentEntity, UserEntity } from "../types.js";

const P = DEFAULT_PAGINATION;

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

function ctxOf(userId: string, over: Partial<V3AuthContext> = {}): V3AuthContext {
  return { token: `key-${userId}`, userId, isAdmin: false, isSystemAdmin: false, ...over };
}

describe("MetadataService · 孤儿 Agent 生命周期（#1321）", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    service = new MetadataService(store, "test-instance", undefined, {
      maxUsersPerInstance: 1000,
      maxTeamsPerInstance: 1000,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  /** 建一个用户 + 团队（owner 自动成为 admin 成员）+ 一个带 chat_memory 资产的 agent。 */
  async function seedMemberWithAgent(teamId: string): Promise<{
    user: UserEntity;
    agent: AgentEntity;
    memoryAssetId: string;
  }> {
    const n = nextSeq();
    const user = await store.createUser({
      auth_provider: "local",
      external_id: `ext-${n}`,
      username: `member${n}`,
    });
    await store.addTeamMember({ team_id: teamId, user_id: user.user_id, role: "member" });
    const agent = await store.createAgent({
      team_id: teamId,
      owner_user_id: user.user_id,
      name: `default-agent-${n}`,
    });
    const memoryAssetId = buildChatMemoryAssetId(teamId, agent.agent_id);
    await store.createAsset({
      asset_id: memoryAssetId,
      team_id: teamId,
      asset_type: "chat_memory",
      name: `Memory of ${agent.agent_id}`,
      owner_user_id: user.user_id,
      source_type: "auto",
      visibility: "team",
    });
    return { user, agent, memoryAssetId };
  }

  async function createTeamWithOwner(): Promise<{ owner: UserEntity; teamId: string }> {
    const n = nextSeq();
    const owner = await store.createUser({
      auth_provider: "local",
      external_id: `ext-owner-${n}`,
      username: `owner${n}`,
    });
    const team = await store.createTeam({ name: `Team ${n}`, owner_user_id: owner.user_id });
    return { owner, teamId: team.team_id };
  }

  it("移除成员：级联硬删除其名下 Agent，不留孤儿", async () => {
    const { owner, teamId } = await createTeamWithOwner();
    const { user, agent, memoryAssetId } = await seedMemberWithAgent(teamId);

    await service.removeTeamMemberForCaller(teamId, user.user_id, ctxOf(owner.user_id));

    // 成员关系已删
    expect(await store.listTeamMembers(teamId, P)).toMatchObject({ total: 1 });
    // Agent 本体 + chat_memory 资产一并清掉（owner 已不是成员，留着就再也删不掉）
    expect(await store.getAgentById(agent.agent_id)).toBeNull();
    expect(await store.getAssetById(memoryAssetId)).toBeNull();
    expect((await store.listAgentsByTeam(teamId, P)).items).toHaveLength(0);
  });

  it("移除成员：级联清掉 Agent 的 task_agents / fixed_assets 绑定", async () => {
    const { owner, teamId } = await createTeamWithOwner();
    const { user, agent } = await seedMemberWithAgent(teamId);
    const task = await store.createTask({ team_id: teamId, creator_user_id: owner.user_id, title: "T" });
    const skillAssetId = newExternalAssetId("skill");
    await store.createAsset({
      asset_id: skillAssetId,
      team_id: teamId,
      asset_type: "skill",
      name: "S",
      owner_user_id: user.user_id,
      source_type: "manual",
    });
    await store.linkTaskAgent(task.task_id, agent.agent_id);
    await store.setAgentFixedAssets(agent.agent_id, [
      { asset_id: skillAssetId, asset_type: "skill", created_by: user.user_id },
    ]);

    await service.removeTeamMemberForCaller(teamId, user.user_id, ctxOf(owner.user_id));

    expect(await store.getAgentById(agent.agent_id)).toBeNull();
    expect((await store.listTaskAgents(task.task_id, P)).items).toHaveLength(0);
    expect((await store.listAgentFixedAssets(agent.agent_id, P)).items).toHaveLength(0);
  });

  it("移除成员：分页遍历，Agent 超过一页时全部删除（不漏删）", async () => {
    const { owner, teamId } = await createTeamWithOwner();
    const n = nextSeq();
    const user = await store.createUser({ auth_provider: "local", external_id: `ext-p-${n}`, username: `page${n}` });
    await store.addTeamMember({ team_id: teamId, user_id: user.user_id, role: "member" });
    const total = DEFAULT_PAGINATION.limit + 5;
    for (let i = 0; i < total; i++) {
      await store.createAgent({ team_id: teamId, owner_user_id: user.user_id, name: `agent-${n}-${i}` });
    }
    expect((await store.listAgentsByTeam(teamId, P, { owner_user_id: user.user_id })).total).toBe(total);

    await service.removeTeamMemberForCaller(teamId, user.user_id, ctxOf(owner.user_id));

    expect((await store.listAgentsByTeam(teamId, P)).items).toHaveLength(0);
  });

  it("删除用户：级联硬删除其跨 team 的全部 Agent（system admin 调用）", async () => {
    const teamA = await createTeamWithOwner();
    const teamB = await createTeamWithOwner();
    const { user, agent: agentA, memoryAssetId } = await seedMemberWithAgent(teamA.teamId);
    const agentB = await store.createAgent({
      team_id: teamB.teamId,
      owner_user_id: user.user_id,
      name: "second-agent",
    });

    await service.deleteUsersForCaller([user.user_id], ctxOf("sys-admin", { isSystemAdmin: true }));

    expect(await store.getUserById(user.user_id)).toBeNull();
    expect(await store.getAgentById(agentA.agent_id)).toBeNull();
    expect(await store.getAgentById(agentB.agent_id)).toBeNull();
    expect(await store.getAssetById(memoryAssetId)).toBeNull();
    // 用户 key 一并删除后，这些 Agent 再也找不到有权的 owner
    expect((await store.listAgentsByOwner(user.user_id, P)).items).toHaveLength(0);
  });

  it("删除用户：非 system admin 仍被拒绝", async () => {
    const n = nextSeq();
    const user = await store.createUser({ auth_provider: "local", external_id: `ext-x-${n}`, username: `plain${n}` });
    await expect(
      service.deleteUsersForCaller([user.user_id], ctxOf("some-user")),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await store.getUserById(user.user_id)).not.toBeNull();
  });

  it("team admin 可代删成员的 Agent（此前裸等值校验一律 403）", async () => {
    const { owner, teamId } = await createTeamWithOwner();
    const { agent } = await seedMemberWithAgent(teamId);

    const result = await service.deleteAgentsForCaller([agent.agent_id], ctxOf(owner.user_id));

    expect(result.deleted_ids).toContain(agent.agent_id);
    expect(result.failed).toHaveLength(0);
    expect(await store.getAgentById(agent.agent_id)).toBeNull();
  });

  it("system admin 无需加入目标 team 即可删除孤儿 Agent", async () => {
    const { teamId } = await createTeamWithOwner();
    const { agent } = await seedMemberWithAgent(teamId);

    const result = await service.deleteAgentsForCaller(
      [agent.agent_id],
      ctxOf("sys-admin", { isSystemAdmin: true }),
    );

    expect(result.deleted_ids).toContain(agent.agent_id);
    expect(await store.getAgentById(agent.agent_id)).toBeNull();
  });

  it("team admin 可归档成员的 Agent", async () => {
    const { owner, teamId } = await createTeamWithOwner();
    const { agent } = await seedMemberWithAgent(teamId);

    const archived = await service.archiveAgentForCaller(agent.agent_id, ctxOf(owner.user_id));

    expect(archived.status).toBe("inactive");
  });

  it("无关的普通用户仍然是 403（权限面没有被过度放宽）", async () => {
    const { teamId } = await createTeamWithOwner();
    const { agent } = await seedMemberWithAgent(teamId);

    await expect(
      service.deleteAgentsForCaller([agent.agent_id], ctxOf("outsider")),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await store.getAgentById(agent.agent_id)).not.toBeNull();
  });
});
