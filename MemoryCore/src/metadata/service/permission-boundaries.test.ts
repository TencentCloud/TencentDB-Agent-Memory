import { describe, expect, it, vi } from "vitest";
import type { IMetadataStore } from "../store/interface.js";
import type { AclEntity, AssetEntity, Permission, TeamMemberEntity } from "../types.js";
import { MetadataService } from "./metadata-service.js";
import { canBindAsset, checkPermission } from "./permission-checker.js";

const asset: AssetEntity = {
  asset_id: "asset-a", team_id: "team-a", asset_type: "skill", name: "API skill",
  owner_user_id: "owner", source_type: "manual", version: 1, visibility: "team",
  status: "approved", usage_count: 0, created_at: "2026-10-09", updated_at: "2026-10-09", metadata_json: "{}",
};
const member: TeamMemberEntity = {
  id: "member-a", team_id: "team-a", user_id: "reader", role: "member", status: "active", joined_at: "2026-10-09",
};
const grant: AclEntity = {
  id: "acl-a", asset_id: "asset-a", subject_type: "user", subject_id: "reader", permission: "read",
  effect: "allow", granted_by: "owner", created_at: "2026-10-09", updated_at: "2026-10-09",
};

describe("asset permission boundaries", () => {
  it.each([null, { ...asset, status: "archived" as const }])("denies unavailable assets even to the owner", (unavailable) => {
    expect(checkPermission({ user: { user_id: "owner" }, asset: unavailable, membership: member, action: "read", aclRecords: [grant] }))
      .toEqual({ allowed: false, reason: "asset_not_available" });
  });

  it("allows an owner to manage a private asset without a team membership", () => {
    expect(checkPermission({ user: { user_id: "owner" }, asset: { ...asset, visibility: "private" }, membership: null, action: "delete", aclRecords: [] }))
      .toEqual({ allowed: true, reason: "owner" });
  });

  it.each([null, { ...member, status: "removed" as const }])("does not let an ACL bypass active team membership", (membership) => {
    expect(checkPermission({ user: { user_id: "reader" }, asset, membership, action: "read", aclRecords: [grant] }))
      .toEqual({ allowed: false, reason: "not_team_member" });
  });

  it("keeps private assets hidden from team admins even with an explicit grant", () => {
    expect(checkPermission({ user: { user_id: "reader" }, asset: { ...asset, visibility: "private" }, membership: { ...member, role: "admin" }, action: "read", aclRecords: [grant] }))
      .toEqual({ allowed: false, reason: "visibility_restricted" });
  });

  it.each<Permission>(["write", "delete", "assign", "share", "use"])("does not give a team member implicit %s permission", (action) => {
    expect(checkPermission({ user: { user_id: "reader" }, asset, membership: member, action, aclRecords: [] }).allowed).toBe(false);
  });

  it.each([
    { subject_type: "user" as const, subject_id: "reader", agentId: undefined },
    { subject_type: "team_role" as const, subject_id: "member", agentId: undefined },
    { subject_type: "agent" as const, subject_id: "agent-a", agentId: "agent-a" },
  ])("honors a matching restricted ACL for $subject_type", ({ subject_type, subject_id, agentId }) => {
    expect(checkPermission({
      user: { user_id: "reader" }, asset: { ...asset, visibility: "restricted" }, membership: member,
      action: "use", agentId, aclRecords: [{ ...grant, permission: "use", subject_type, subject_id }],
    })).toEqual({ allowed: true, reason: "acl:acl-a" });
  });

  it.each([
    { ...grant, subject_id: "another-user" },
    { ...grant, permission: "write" as const },
    { ...grant, effect: "deny" as const },
    { ...grant, subject_type: "agent" as const, subject_id: "agent-a" },
  ])("does not authorize a restricted asset with an unrelated or non-allow ACL", (acl) => {
    expect(checkPermission({ user: { user_id: "reader" }, asset: { ...asset, visibility: "restricted" }, membership: member, action: "read", aclRecords: [acl] }).allowed).toBe(false);
  });

  it.each(["private", "team", "agent"] as const)("rejects binding %s assets across teams", (visibility) => {
    expect(canBindAsset({ team_id: "team-b", owner_user_id: "owner" }, { ...asset, visibility })).toBe(false);
  });

  it("requires matching ownership for private binding and rejects task/restricted bindings", () => {
    const agent = { team_id: "team-a", owner_user_id: "owner" };
    expect(canBindAsset(agent, { ...asset, visibility: "private" })).toBe(true);
    expect(canBindAsset({ ...agent, owner_user_id: "another-owner" }, { ...asset, visibility: "private" })).toBe(false);
    expect(canBindAsset(agent, { ...asset, visibility: "task" })).toBe(false);
    expect(canBindAsset(agent, { ...asset, visibility: "restricted" })).toBe(false);
  });
});

function serviceFixture(overrides: Partial<AssetEntity> = {}, membership: TeamMemberEntity | null = member) {
  const getAssetById = vi.fn<IMetadataStore["getAssetById"]>().mockResolvedValue({ ...asset, ...overrides });
  const getTeamMember = vi.fn<IMetadataStore["getTeamMember"]>().mockResolvedValue(membership);
  const listAclByAsset = vi.fn<IMetadataStore["listAclByAsset"]>().mockResolvedValue({ items: [grant], total: 1 });
  const store = { getAssetById, getTeamMember, listAclByAsset } as unknown as IMetadataStore;
  return { svc: new MetadataService(store), getAssetById, getTeamMember, listAclByAsset };
}

describe("MetadataService.checkAssetPermission", () => {
  it.each<Permission>(["read", "write"])("loads explicit restricted %s grants before denying a member", async (action) => {
    const f = serviceFixture({ visibility: "restricted" });
    f.listAclByAsset.mockResolvedValue({ items: [{ ...grant, permission: action }], total: 1 });
    await expect(f.svc.checkAssetPermission({ user_id: "reader", asset_id: "asset-a", action }))
      .resolves.toEqual({ allowed: true, reason: "acl:acl-a" });
    expect(f.getTeamMember).toHaveBeenCalledWith("team-a", "reader");
    expect(f.listAclByAsset).toHaveBeenCalledWith("asset-a", { limit: 100, offset: 0 });
  });

  it("keeps restricted assets denied when no matching grant exists", async () => {
    const f = serviceFixture({ visibility: "restricted" });
    f.listAclByAsset.mockResolvedValue({ items: [{ ...grant, subject_id: "somebody-else" }], total: 1 });
    await expect(f.svc.checkAssetPermission({ user_id: "reader", asset_id: "asset-a", action: "read" }))
      .resolves.toEqual({ allowed: false, reason: "visibility_restricted" });
  });

  it.each([
    { visibility: "private" as const, membership: { ...member, role: "admin" as const } },
    { visibility: "restricted" as const, membership: null },
    { visibility: "restricted" as const, membership: { ...member, status: "removed" as const } },
  ])("does not load ACLs to bypass privacy or membership prerequisites", async ({ visibility, membership }) => {
    const f = serviceFixture({ visibility }, membership);
    expect((await f.svc.checkAssetPermission({ user_id: "reader", asset_id: "asset-a", action: "read" })).allowed).toBe(false);
    expect(f.listAclByAsset).not.toHaveBeenCalled();
  });

  it("avoids ACL queries for owner and team-role defaults", async () => {
    const f = serviceFixture();
    expect((await f.svc.checkAssetPermission({ user_id: "owner", asset_id: "asset-a", action: "delete" })).allowed).toBe(true);
    expect(f.getTeamMember).not.toHaveBeenCalled();
    expect((await f.svc.checkAssetPermission({ user_id: "reader", asset_id: "asset-a", action: "read" })).allowed).toBe(true);
    expect(f.listAclByAsset).not.toHaveBeenCalled();
  });
});
