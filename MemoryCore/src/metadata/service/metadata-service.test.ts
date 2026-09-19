/**
 * MetadataService —— 孤儿 Agent 生命周期与删除权限面（issue #1321）。
 *
 * 覆盖三条缺陷链的修复：
 *   1. 成员被移出团队 → 其在本团队的 Agent 级联清理（不再产生孤儿）；
 *   2. 用户被删除 → 其名下所有 Agent 级联清理（owner 消失后不再留无法清理的资产）；
 *   3. agent/delete、agent/archive → owner / team admin / system_admin 三档放行，
 *      与 createAgentForCaller 的「admin 代新用户建 Agent」对称。
 *
 * 用真实 SqliteMetadataStore(":memory:") 跑，不打桩 —— 级联涉及多表（meta_agents /
 * meta_task_agents / meta_agent_fixed_assets / meta_assets），打桩会掩盖真实残留。
 * V3AuthContext 只需 userId + isSystemAdmin，故直接构造字面量，不 mint user_key。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { MetadataService } from "./metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/** 只用到 userId / isSystemAdmin 两个字段；token 仅作占位。 */
function ctxOf(userId: string, isSystemAdmin = false): V3AuthContext {
  return { token: "test-token", userId, isAdmin: false, isSystemAdmin };
}

const SYSTEM_ADMIN = ctxOf("u-system-admin", true);

describe("MetadataService · orphan agent lifecycle (#1321)", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    svc = new MetadataService(store);
  });

  afterEach(async () => {
    await store.close();
  });

  /** service 层建号入口是 createNormalUser（返回 CreateUserApiResult，只取 user_id）。 */
  async function mkUser(prefix: string): Promise<{ user_id: string }> {
    const { user_id } = await svc.createNormalUser({ username: uniq(prefix) });
    return { user_id };
  }

  /** 建一个 team（owner 自动成为 role=admin 的成员）+ 一名 role=member 的成员。 */
  async function makeTeamWithMember() {
    const teamOwner = await mkUser("owner");
    const member = await mkUser("member");
    const team = await svc.createTeam({ name: uniq("team"), owner_user_id: teamOwner.user_id });
    await svc.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
    return { teamOwner, member, team };
  }

  // ── 缺陷链 1：成员移除不级联 Agent ──

  describe("removeTeamMemberForCaller 级联清理", () => {
    it("成员被移出团队时，其在本团队的 Agent 一并删除，不留孤儿", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({
        team_id: team.team_id,
        owner_user_id: member.user_id,
        name: "member-default",
      });
      const memoryAssetId = buildChatMemoryAssetId(team.team_id, agent.agent_id);
      // createAgent 会顺手 mint chat_memory 资产，这里确认它确实存在
      expect(await store.getAssetById(memoryAssetId)).not.toBeNull();

      await svc.removeTeamMemberForCaller(team.team_id, member.user_id, ctxOf(teamOwner.user_id));

      // Agent 本体与它的 chat_memory 资产记录都要清干净
      expect(await svc.getAgentById(agent.agent_id)).toBeNull();
      expect(await store.getAssetById(memoryAssetId)).toBeNull();
      const owned = await svc.listAgentsByOwner(member.user_id);
      expect(owned.items).toHaveLength(0);
      // 成员关系行本身也要移除
      expect(await store.getTeamMember(team.team_id, member.user_id)).toBeNull();
    });

    it("团队 owner 的 Agent 不受影响（owner 不可被移出团队）", async () => {
      const { teamOwner, team } = await makeTeamWithMember();
      const ownerAgent = await svc.createAgent({
        team_id: team.team_id,
        owner_user_id: teamOwner.user_id,
        name: "owner-agent",
      });

      await expect(
        svc.removeTeamMemberForCaller(team.team_id, teamOwner.user_id, ctxOf(teamOwner.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(await svc.getAgentById(ownerAgent.agent_id)).not.toBeNull();
    });

    it("非 team admin 无法移除成员（权限校验先于级联）", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({
        team_id: team.team_id,
        owner_user_id: member.user_id,
        name: "member-default",
      });

      // member 自己（role=member）不是 admin
      await expect(
        svc.removeTeamMemberForCaller(team.team_id, member.user_id, ctxOf(member.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });
      // 校验失败时不得留下半截级联副作用
      expect(await svc.getAgentById(agent.agent_id)).not.toBeNull();
      void teamOwner;
    });
  });

  // ── 缺陷链 2：用户删除不级联 Agent ──

  describe("deleteUsersForCaller 级联清理", () => {
    it("删除用户时级联删除其名下所有 Agent（跨多个团队）", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const otherOwner = await mkUser("owner2");
      const otherTeam = await svc.createTeam({ name: uniq("team2"), owner_user_id: otherOwner.user_id });
      await svc.addTeamMember({ team_id: otherTeam.team_id, user_id: member.user_id, role: "member" });

      const a1 = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "a1" });
      const a2 = await svc.createAgent({ team_id: otherTeam.team_id, owner_user_id: member.user_id, name: "a2" });

      await svc.deleteUsersForCaller([member.user_id], SYSTEM_ADMIN);

      expect(await svc.getUserById(member.user_id)).toBeNull();
      expect(await svc.getAgentById(a1.agent_id)).toBeNull();
      expect(await svc.getAgentById(a2.agent_id)).toBeNull();
      expect((await svc.listAgentsByOwner(member.user_id)).items).toHaveLength(0);
      void teamOwner;
    });

    it("非 system_admin 无法删除用户，且不产生任何级联副作用", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "a1" });

      await expect(
        svc.deleteUsersForCaller([member.user_id], ctxOf(teamOwner.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });

      expect(await svc.getUserById(member.user_id)).not.toBeNull();
      expect(await svc.getAgentById(agent.agent_id)).not.toBeNull();
    });

    it("删除不存在的用户不产生副作用（幂等）", async () => {
      const { member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "a1" });

      const result = await svc.deleteUsersForCaller(["u-does-not-exist"], SYSTEM_ADMIN);

      expect(result.deleted_ids).toHaveLength(0);
      expect(await svc.getAgentById(agent.agent_id)).not.toBeNull();
    });
  });

  // ── 缺陷链 3：Agent 删除无 admin 旁路 ──

  describe("deleteAgents / archiveAgent 的三档权限面", () => {
    /**
     * 构造孤儿 Agent：在 store 层直接删掉 owner（绕过 service 级联），
     * 于是 owner_user_id 悬空 —— 这正是 issue 里「任何角色都无法删除」的起始状态。
     */
    async function makeOrphanAgent() {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "orphan" });
      const outsider = await mkUser("outsider");
      await store.deleteUsers([member.user_id]);
      return { teamOwner, member, team, agent, outsider };
    }

    it("team admin 可以删除孤儿 Agent（修复前恒 403）", async () => {
      const { agent, teamOwner } = await makeOrphanAgent();
      const result = await svc.deleteAgentsForCaller([agent.agent_id], ctxOf(teamOwner.user_id));
      expect(result.deleted_ids).toEqual([agent.agent_id]);
      expect(await svc.getAgentById(agent.agent_id)).toBeNull();
    });

    it("team admin 可以归档孤儿 Agent", async () => {
      const { agent, teamOwner } = await makeOrphanAgent();
      const archived = await svc.archiveAgentForCaller(agent.agent_id, ctxOf(teamOwner.user_id));
      expect(archived.status).toBe("inactive");
    });

    it("system_admin 无需加入目标 team 即可删除孤儿 Agent", async () => {
      const { agent } = await makeOrphanAgent();
      const result = await svc.deleteAgentsForCaller([agent.agent_id], SYSTEM_ADMIN);
      expect(result.deleted_ids).toEqual([agent.agent_id]);
      expect(await svc.getAgentById(agent.agent_id)).toBeNull();
    });

    it("system_admin 无需加入目标 team 即可归档孤儿 Agent", async () => {
      const { agent } = await makeOrphanAgent();
      const archived = await svc.archiveAgentForCaller(agent.agent_id, SYSTEM_ADMIN);
      expect(archived.status).toBe("inactive");
    });

    it("既非 owner/team admin 也非 system_admin 的旁观者仍被拒绝", async () => {
      const { agent, outsider } = await makeOrphanAgent();
      await expect(
        svc.deleteAgentsForCaller([agent.agent_id], ctxOf(outsider.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });
      await expect(
        svc.archiveAgentForCaller(agent.agent_id, ctxOf(outsider.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(await svc.getAgentById(agent.agent_id)).not.toBeNull();
    });

    it("普通 team member（非 admin）删除他人的 Agent 仍被拒绝", async () => {
      const { team, agent, outsider } = await makeOrphanAgent();
      await svc.addTeamMember({ team_id: team.team_id, user_id: outsider.user_id, role: "member" });
      await expect(
        svc.deleteAgentsForCaller([agent.agent_id], ctxOf(outsider.user_id)),
      ).rejects.toMatchObject({ code: "permission_denied" });
    });

    it("owner 本人仍可删除自己的 Agent（原有路径不回退）", async () => {
      const owner = await mkUser("self");
      const team = await svc.createTeam({ name: uniq("team"), owner_user_id: owner.user_id });
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "mine" });

      const result = await svc.deleteAgentsForCaller([agent.agent_id], ctxOf(owner.user_id));
      expect(result.deleted_ids).toEqual([agent.agent_id]);
    });

    it("不存在的 agent 仍然报 agent_not_found（admin 旁路不吞 404）", async () => {
      await expect(
        svc.archiveAgentForCaller("agt-does-not-exist", SYSTEM_ADMIN),
      ).rejects.toMatchObject({ code: "agent_not_found" });
    });
  });

  // ── 级联完整性：Agent 的绑定不留残留 ──

  describe("级联清理的完整性", () => {
    it("成员移除后，该 Agent 的 fixed_assets 绑定与 task 关联一并清掉", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "a1" });
      const task = await svc.createTask({ team_id: team.team_id, creator_user_id: teamOwner.user_id, title: "T" });
      await store.linkTaskAgent(task.task_id, agent.agent_id);

      await svc.removeTeamMemberForCaller(team.team_id, member.user_id, ctxOf(teamOwner.user_id));

      expect((await store.listTaskAgents(task.task_id, { limit: 20, offset: 0 })).items).toHaveLength(0);
      expect((await store.listAgentFixedAssets(agent.agent_id, { limit: 20, offset: 0 })).items).toHaveLength(0);
    });
  });

  // ── 设计边界：MetaCallContext 之外的 store 级联 ──

  describe("deleteTeamsForCaller", () => {
    it("删除团队时队内 Agent 一并级联清理", async () => {
      const { teamOwner, member, team } = await makeTeamWithMember();
      const agent = await svc.createAgent({ team_id: team.team_id, owner_user_id: member.user_id, name: "a1" });
      const memoryAssetId = buildChatMemoryAssetId(team.team_id, agent.agent_id);

      await svc.deleteTeamsForCaller([team.team_id], ctxOf(teamOwner.user_id));

      expect(await svc.getTeamById(team.team_id)).toBeNull();
      expect(await svc.getAgentById(agent.agent_id)).toBeNull();
      expect(await store.getAssetById(memoryAssetId)).toBeNull();
    });
  });
});
