/**
 * M3 (#1321) Agent 访问控制 + 级联删除的服务层回归。
 *
 * 修复前的三条缺陷链：
 *   1. removeTeamMemberForCaller 只删成员行 → 成员名下 Agent 变孤儿；
 *   2. deleteUsersForCaller 不级联 Agent → owner 悬空；
 *   3. deleteAgentsForCaller / archiveAgentForCaller 严格 owner-only，
 *      team admin / system admin 都删不掉孤儿 Agent。
 *
 * 级联落库在 store 层（sqlite + mongodb 对齐，v2 逃生通道同样受益）；
 * 本文件验证服务层授权矩阵与端到端级联行为。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError, MetadataService } from "./metadata-service.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { IMetadataStore } from "../store/interface.js";

let seq = 0;

function makeCtx(userId: string | undefined, opts: { isSystemAdmin?: boolean } = {}): V3AuthContext {
  return { token: "test-key", userId, isAdmin: false, isSystemAdmin: opts.isSystemAdmin ?? false };
}

async function createUser(store: IMetadataStore, over: Record<string, unknown> = {}) {
  seq += 1;
  return store.createUser({
    auth_provider: "local",
    external_id: `ext-${seq}`,
    username: `user${seq}`,
    ...over,
  } as Parameters<IMetadataStore["createUser"]>[0]);
}

describe("MetadataService agent 删除授权矩阵 + 级联 (#1321)", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let owner: Awaited<ReturnType<IMetadataStore["createUser"]>>;
  let admin: Awaited<ReturnType<IMetadataStore["createUser"]>>;
  let member: Awaited<ReturnType<IMetadataStore["createUser"]>>;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store);

    owner = await createUser(store); // team owner（自动为 admin 成员）
    const team = await store.createTeam({ name: "Team", owner_user_id: owner.user_id });
    teamId = team.team_id;

    admin = await createUser(store);
    await store.addTeamMember({ team_id: teamId, user_id: admin.user_id, role: "admin" });
    member = await createUser(store);
    await store.addTeamMember({ team_id: teamId, user_id: member.user_id, role: "member" });

    agentId = (await store.createAgent({ team_id: teamId, owner_user_id: member.user_id, name: "MemberAgent" })).agent_id;
  });

  afterEach(async () => {
    store.close();
  });

  it("owner 仍可删除自己的 Agent（原有行为不变）", async () => {
    const result = await svc.deleteAgentsForCaller([agentId], makeCtx(member.user_id));
    expect(result.deleted_ids).toContain(agentId);
    expect(await store.getAgentById(agentId)).toBeNull();
  });

  it("team admin 可删除他人的 Agent（修复前 403，孤儿 Agent 的处置通道）", async () => {
    const result = await svc.deleteAgentsForCaller([agentId], makeCtx(admin.user_id));
    expect(result.deleted_ids).toContain(agentId);
    expect(await store.getAgentById(agentId)).toBeNull();
  });

  it("team admin 可归档他人的 Agent", async () => {
    const archived = await svc.archiveAgentForCaller(agentId, makeCtx(admin.user_id));
    // archiveAgent 的语义是置为 inactive（非物理删除）。
    expect(archived.status).toBe("inactive");
  });

  it("system admin 无需团队成员身份即可删除（修复前卡在成员校验）", async () => {
    const sys = await createUser(store, { user_type: "system_admin" });
    const result = await svc.deleteAgentsForCaller([agentId], makeCtx(sys.user_id, { isSystemAdmin: true }));
    expect(result.deleted_ids).toContain(agentId);
  });

  it("普通成员删除他人 Agent 仍被拒绝（授权矩阵不放宽）", async () => {
    // plain 是团队成员但非 admin，也非 Agent owner —— 修复前后都必须拒绝。
    const plain = await createUser(store);
    await store.addTeamMember({ team_id: teamId, user_id: plain.user_id, role: "member" });
    await expect(svc.deleteAgentsForCaller([agentId], makeCtx(plain.user_id))).rejects.toMatchObject({
      code: "permission_denied",
    });
    // 完全的局外人（非团队成员）同样拒绝。
    const outsider = await createUser(store);
    await expect(svc.deleteAgentsForCaller([agentId], makeCtx(outsider.user_id))).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await store.getAgentById(agentId)).not.toBeNull();
  });

  it("Agent 不存在时报 agent_not_found（旁路不跳过存在性校验）", async () => {
    await expect(
      svc.deleteAgentsForCaller(["agt-not-exist"], makeCtx("sys", { isSystemAdmin: true })),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("移除成员时级联删除其在本团队的 Agent；其它团队不受影响", async () => {
    // 成员在第二个团队（自建，本人为 owner）另有 Agent。
    const otherTeam = await store.createTeam({ name: "TeamB", owner_user_id: member.user_id });
    const agentInB = (
      await store.createAgent({ team_id: otherTeam.team_id, owner_user_id: member.user_id, name: "AgentB" })
    ).agent_id;

    await svc.removeTeamMemberForCaller(teamId, member.user_id, makeCtx(admin.user_id));

    expect(await store.getAgentById(agentId)).toBeNull();
    expect(await store.getAgentById(agentInB)).not.toBeNull();
    const members = await store.listTeamMembers(teamId, { limit: 50, offset: 0 });
    expect(members.items.map((m) => m.user_id)).not.toContain(member.user_id);
  });

  it("删除用户时级联删除其全部 Agent（孤儿源头修复）", async () => {
    await svc.deleteUsersForCaller([member.user_id], makeCtx(owner.user_id, { isSystemAdmin: true }));
    expect(await store.getAgentById(agentId)).toBeNull();
    const agents = await store.listAgentsByOwner(member.user_id, { limit: 50, offset: 0 });
    expect(agents.items).toHaveLength(0);
  });
});
