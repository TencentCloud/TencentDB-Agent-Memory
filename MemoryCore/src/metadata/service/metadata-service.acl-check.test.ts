// Regression for #1522: an explicit `acl/grant` on a `visibility=restricted`
// asset had no effect on the check path — the service's lazy ACL load only
// triggered on reason `no_permission`, but the restricted denial comes back as
// `visibility_restricted`, so granted access was unreachable from `acl/check`.
//
// Contract after the fix:
//   - restricted + explicit user grant → allowed via ACL (the documented sharing
//     model becomes reachable);
//   - restricted without grant → still denied as `visibility_restricted`;
//   - private + grant → STILL denied (private strictly excludes non-owners by
//     design; ACL must not override it);
//   - owner → allowed regardless.
import { describe, expect, it } from "vitest";
import { MetadataService } from "./metadata-service.js";
import type { AssetEntity, TeamMemberEntity, AclEntity } from "../types.js";

const assetBase = {
  team_id: "team-1",
  asset_type: "code_graph" as const,
  name: "asset",
  owner_user_id: "owner-1",
  source_type: "git",
  version: 1,
  status: "active" as const,
  usage_count: 0,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  metadata_json: "{}",
};

function makeAsset(visibility: "restricted" | "private"): AssetEntity {
  return { ...assetBase, asset_id: "a-1", visibility } as AssetEntity;
}

const member: TeamMemberEntity = {
  id: "m-1",
  team_id: "team-1",
  user_id: "user-1",
  role: "member",
  joined_at: "2026-10-01T00:00:00Z",
  status: "active",
};

const grant: AclEntity = {
  id: "acl-1",
  asset_id: "a-1",
  subject_type: "user",
  subject_id: "user-1",
  permission: "read",
  effect: "allow",
  granted_by: "owner-1",
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
};

function makeService(asset: AssetEntity, acls: AclEntity[]): MetadataService {
  const store = {
    getAssetById: async (id: string) => (id === asset.asset_id ? asset : null),
    getTeamMember: async () => member,
    listAclByAsset: async () => ({ items: acls, total: acls.length, offset: 0, limit: 100 }),
  };
  return new MetadataService(store as never);
}

describe("restricted asset ACL grant reaches the check path (#1522)", () => {
  it("explicit user grant → member read allowed via ACL", async () => {
    const svc = makeService(makeAsset("restricted"), [grant]);
    const res = await svc.checkAssetPermission({ asset_id: "a-1", user_id: "user-1", action: "read" });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("acl:acl-1");
  });

  it("restricted without grant → still denied as visibility_restricted", async () => {
    const svc = makeService(makeAsset("restricted"), []);
    const res = await svc.checkAssetPermission({ asset_id: "a-1", user_id: "user-1", action: "read" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("visibility_restricted");
  });

  it("private + grant → still denied (ACL must not override private)", async () => {
    const svc = makeService(makeAsset("private"), [grant]);
    const res = await svc.checkAssetPermission({ asset_id: "a-1", user_id: "user-1", action: "read" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("visibility_restricted");
  });

  it("owner → allowed regardless of visibility", async () => {
    const svc = makeService(makeAsset("restricted"), []);
    const res = await svc.checkAssetPermission({ asset_id: "a-1", user_id: "owner-1", action: "read" });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("owner");
  });
});
