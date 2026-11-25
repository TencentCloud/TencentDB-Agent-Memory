import { describe, expect, it } from "vitest";
import type { V3AuthContext } from "../router/auth.js";
import type { AssetEntity, TeamMemberEntity } from "../types.js";
import { MetadataService } from "./metadata-service.js";

const OWNER = "user-owner";
const MEMBER = "user-member";
const ADMIN = "user-admin";
const STRANGER = "user-stranger";
const TEAM = "team-1";

const member = (userId: string, role: TeamMemberEntity["role"] = "member"): TeamMemberEntity => ({
  id: `member-${userId}`,
  team_id: TEAM,
  user_id: userId,
  role,
  joined_at: "2026-10-22T00:00:00.000Z",
  status: "active",
});

const asset = (
  assetId: string,
  visibility: AssetEntity["visibility"],
  ownerUserId = OWNER,
): AssetEntity => ({
  asset_id: assetId,
  team_id: TEAM,
  asset_type: "skill",
  name: assetId,
  owner_user_id: ownerUserId,
  source_type: "manual",
  version: 1,
  visibility,
  status: "active",
  usage_count: 0,
  created_at: "2026-10-22T00:00:00.000Z",
  updated_at: "2026-10-22T00:00:00.000Z",
  metadata_json: "{}",
});

const caller = (userId: string): V3AuthContext => ({
  token: `key-${userId}`,
  userId,
  isAdmin: false,
  isSystemAdmin: false,
});

function makeService(assets: AssetEntity[], members: TeamMemberEntity[]) {
  const store = {
    getAssetById: async (assetId: string) =>
      assets.find((candidate) => candidate.asset_id === assetId) ?? null,
    getTeamMember: async (teamId: string, userId: string) =>
      members.find((candidate) => candidate.team_id === teamId && candidate.user_id === userId) ?? null,
    allAclRecords: async () => [],
    listAssetsByTeam: async (
      teamId: string,
      pagination: { limit: number; offset: number },
    ) => {
      const teamAssets = assets.filter(
        (candidate) => candidate.team_id === teamId && candidate.status === "active",
      );
      return {
        items: teamAssets.slice(pagination.offset, pagination.offset + pagination.limit),
        total: teamAssets.length,
      };
    },
  };
  return new MetadataService(store as any, "default");
}

describe("caller-scoped asset reads", () => {
  it("returns a private asset to its owner but not to a stranger", async () => {
    const service = makeService(
      [asset("private-owner", "private")],
      [member(OWNER)],
    );

    await expect(service.getAssetForCaller("private-owner", caller(OWNER)))
      .resolves.toMatchObject({ asset_id: "private-owner" });
    await expect(service.getAssetForCaller("private-owner", caller(STRANGER)))
      .resolves.toBeNull();
  });

  it("returns an empty page when a stranger enumerates another team", async () => {
    const service = makeService(
      [asset("private-owner", "private"), asset("team-shared", "team")],
      [member(OWNER), member(MEMBER)],
    );

    await expect(service.listAssetsForCaller(
      { team_id: TEAM, limit: 20, offset: 0 },
      caller(STRANGER),
    )).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("hides another member's private asset even from a team admin", async () => {
    const service = makeService(
      [asset("private-owner", "private")],
      [member(OWNER), member(ADMIN, "admin")],
    );

    await expect(service.getAssetForCaller("private-owner", caller(ADMIN)))
      .resolves.toBeNull();
  });

  it("lists team assets while keeping another member's private asset hidden", async () => {
    const service = makeService(
      [
        asset("private-owner", "private"),
        asset("team-shared", "team"),
        asset("private-member", "private", MEMBER),
      ],
      [member(OWNER), member(MEMBER)],
    );

    const page = await service.listAssetsForCaller(
      { team_id: TEAM, limit: 20, offset: 0 },
      caller(MEMBER),
    );

    expect(page.items.map((item) => item.asset_id).sort()).toEqual([
      "private-member",
      "team-shared",
    ]);
    expect(page.total).toBe(2);
  });
});
