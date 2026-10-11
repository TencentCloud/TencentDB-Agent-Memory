import { describe, expect, it, vi } from "vitest";
import type { IMetadataStore } from "../store/interface.js";
import type { AclEntity, AssetEntity, AssetVisibility, Permission, TeamMemberEntity } from "../types.js";
import { MetadataService } from "./metadata-service.js";

describe("checkAssetPermission lazy ACL loading", () => {
  it.each([
    ["private", "read", "member", false, false],
    ["private", "write", "member", false, false],
    ["private", "write", "admin", false, false],
    ["task", "read", "member", true, false],
    ["task", "write", "member", false, false],
    ["task", "write", "admin", true, false],
    ["restricted", "read", "member", true, true],
    ["restricted", "write", "member", true, true],
    ["restricted", "write", "admin", true, false],
    ["team", "read", "member", true, false],
    ["team", "write", "member", true, true],
  ] as const)("%s %s by %s: allowed=%s, loads ACL=%s", async (visibility, action, role, allowed, loadsAcl) => {
    const { service, listAclByAsset } = setup(visibility, action, role);

    const result = await service.checkAssetPermission({ user_id: "member", asset_id: "asset", action });

    expect(result.allowed).toBe(allowed);
    expect(listAclByAsset).toHaveBeenCalledTimes(loadsAcl ? 1 : 0);
    if (loadsAcl) expect(result.reason).toBe("acl:grant");
  });

  it("denies restricted access when the loaded ACL does not grant the requested action", async () => {
    const { service, listAclByAsset } = setup("restricted", "write", "member");

    const result = await service.checkAssetPermission({ user_id: "member", asset_id: "asset", action: "read" });

    expect(result).toEqual({ allowed: false, reason: "visibility_restricted" });
    expect(listAclByAsset).toHaveBeenCalledOnce();
  });
});

function setup(visibility: AssetVisibility, permission: Permission, role: TeamMemberEntity["role"]) {
  const asset: AssetEntity = {
    asset_id: "asset", team_id: "team", owner_user_id: "owner", asset_type: "skill",
    name: "skill", source_type: "test", version: 1, visibility, status: "draft",
    usage_count: 0, created_at: "2026-09-01", updated_at: "2026-09-01", metadata_json: "{}",
  };
  const membership: TeamMemberEntity = {
    id: "membership", team_id: "team", user_id: "member", role, status: "active", joined_at: "2026-09-01",
  };
  const grant: AclEntity = {
    id: "grant", asset_id: "asset", subject_type: "user", subject_id: "member",
    permission, effect: "allow", granted_by: "owner", created_at: "2026-09-01", updated_at: "2026-09-01",
  };
  const listAclByAsset = vi.fn(async () => ({ items: [grant], total: 1 }));
  const store = {
    getAssetById: async () => asset,
    getTeamMember: async () => membership,
    listAclByAsset,
  } as unknown as IMetadataStore;
  return { service: new MetadataService(store), listAclByAsset };
}
