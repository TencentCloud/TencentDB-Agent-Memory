/**
 * issue #1321 回归测试：成员移除 / 用户删除后的 Agent 级联清理。
 *
 * 覆盖三类曾经出问题的行为：
 *   1. 跨团队隔离 —— 移除 A 队成员资格，不能连带删掉他在 B 队的 Agent
 *   2. 分页完整性 —— Agent 数量超过单页上限时也要删干净，不留残余孤儿
 *   3. 权限放通 —— team admin / system_admin 能处理不属于自己的 Agent
 */

import { describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import type { V3AuthContext } from "../router/auth.js";

function setup(): { service: MetadataService } {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  return { service: new MetadataService(store, "default-instance") };
}

/** 构造调用方身份；isSystemAdmin=true 模拟内核管理员 key。 */
function ctxOf(userId: string, isSystemAdmin = false): V3AuthContext {
  return { token: "test-token", userId, isAdmin: false, isSystemAdmin };
}

async function makeAgent(
  service: MetadataService,
  teamId: string,
  ownerId: string,
  name: string,
): Promise<string> {
  const agent = await service.createAgent({
    team_id: teamId,
    owner_user_id: ownerId,
    name,
    visibility: "private",
    status: "active",
  });
  return agent.agent_id;
}

describe("issue #1321 agent cascade cleanup", () => {
  it("移除成员只删本团队的 Agent，不影响该成员在其它团队的 Agent", async () => {
    const { service } = setup();
    const admin = await service.createNormalUser({ username: "admin" });
    const member = await service.createNormalUser({ username: "member" });

    const teamA = await service.createTeam({ name: "team-a", owner_user_id: admin.user_id });
    const teamB = await service.createTeam({ name: "team-b", owner_user_id: admin.user_id });

    await service.addTeamMember({ team_id: teamA.team_id, user_id: member.user_id, role: "member" });
    await service.addTeamMember({ team_id: teamB.team_id, user_id: member.user_id, role: "member" });

    const agentInA = await makeAgent(service, teamA.team_id, member.user_id, "agent-a");
    const agentInB = await makeAgent(service, teamB.team_id, member.user_id, "agent-b");

    await service.removeTeamMemberForCaller(teamA.team_id, member.user_id, ctxOf(admin.user_id));

    // team-a 的 Agent 应随成员资格一并清除
    expect(await service.getAgentById(agentInA)).toBeNull();
    // team-b 的 Agent 不归本次退群处理，必须原样保留
    expect(await service.getAgentById(agentInB)).not.toBeNull();
  });

  it("删除用户时删光其全部 Agent，数量超过单页上限也不留残余", async () => {
    const { service } = setup();
    const admin = await service.createNormalUser({ username: "admin" });
    const victim = await service.createNormalUser({ username: "victim" });
    const team = await service.createTeam({ name: "team", owner_user_id: admin.user_id });

    // 故意超过 deleteAllAgentsOf 的单页取数上限，验证循环分页不会漏删
    const total = 1001;
    for (let i = 0; i < total; i++) {
      await makeAgent(service, team.team_id, victim.user_id, `agent-${i}`);
    }
    const before = await service.listAgentsByOwner(victim.user_id, { limit: total + 1, offset: 0 });
    expect(before.total).toBe(total);

    await service.deleteUsers([victim.user_id]);

    const after = await service.listAgentsByOwner(victim.user_id, { limit: total + 1, offset: 0 });
    expect(after.total).toBe(0);
  });

  it("team admin 可以删除成员的 Agent（旧实现固定返回 403）", async () => {
    const { service } = setup();
    const admin = await service.createNormalUser({ username: "admin" });
    const member = await service.createNormalUser({ username: "member" });
    const team = await service.createTeam({ name: "team", owner_user_id: admin.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });

    const agentId = await makeAgent(service, team.team_id, member.user_id, "member-agent");

    await service.deleteAgentsForCaller([agentId], ctxOf(admin.user_id));
    expect(await service.getAgentById(agentId)).toBeNull();
  });

  it("system_admin 可以删除不属于自己的 Agent", async () => {
    const { service } = setup();
    const admin = await service.createNormalUser({ username: "admin" });
    const other = await service.createNormalUser({ username: "other" });
    const team = await service.createTeam({ name: "team", owner_user_id: admin.user_id });

    const agentId = await makeAgent(service, team.team_id, other.user_id, "other-agent");

    await service.deleteAgentsForCaller([agentId], ctxOf("sys-admin", true));
    expect(await service.getAgentById(agentId)).toBeNull();
  });

  it("非 owner 且非管理员的普通成员，不能删除他人的 Agent", async () => {
    const { service } = setup();
    const admin = await service.createNormalUser({ username: "admin" });
    const owner = await service.createNormalUser({ username: "owner" });
    const stranger = await service.createNormalUser({ username: "stranger" });
    const team = await service.createTeam({ name: "team", owner_user_id: admin.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: owner.user_id, role: "member" });
    await service.addTeamMember({ team_id: team.team_id, user_id: stranger.user_id, role: "member" });

    const agentId = await makeAgent(service, team.team_id, owner.user_id, "owned-agent");

    // 权限收紧的一侧也要锁住：放通 admin 不等于人人可删
    await expect(service.deleteAgentsForCaller([agentId], ctxOf(stranger.user_id))).rejects.toThrow();
    expect(await service.getAgentById(agentId)).not.toBeNull();
  });
});
