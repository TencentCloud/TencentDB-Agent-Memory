/**
 * Caller-scoped reads for asset/get and asset/list (#1469).
 *
 * private assets are owner-only: strangers, teammates, and team admins
 * are denied. team visibility stays readable by members. Writes stay
 * owner-only.
 */
import type * as http from "node:http";
import { describe, expect, it } from "vitest";
import type { IMetadataStore } from "../store/interface.js";
import type {
  AssetEntity,
  AssetFilter,
  AssetVisibility,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  TeamMemberEntity,
  TeamRole,
  UserEntity,
} from "../types.js";
import type { V3AuthContext } from "../router/auth.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import { MetadataService } from "./metadata-service.js";

const TEAM = "team-a";
const OWNER = "usr-owner";
const VICTIM = "usr-victim";
const ADMIN = "usr-admin";
const STRANGER = "usr-stranger";

const PRIV_OWNER = "ast-priv-owner";
const PRIV_SECRET = "ast-priv-secret";
const TEAM_SHARED = "ast-team-shared";

function caller(userId: string): V3AuthContext {
  return { token: `sk-mem-${userId}`, userId, isAdmin: false, isSystemAdmin: false };
}

function asset(fields: {
  asset_id: string;
  owner_user_id: string;
  visibility: AssetVisibility;
  name: string;
}): AssetEntity {
  return {
    asset_id: fields.asset_id,
    team_id: TEAM,
    asset_type: "skill",
    name: fields.name,
    description: null,
    owner_user_id: fields.owner_user_id,
    source_type: "manual",
    source_ref: null,
    version: 1,
    visibility: fields.visibility,
    status: "approved",
    confidence: null,
    expires_at: null,
    last_used_at: null,
    usage_count: 0,
    content_ref: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    metadata_json: "{}",
  };
}

function member(userId: string, role: TeamRole): TeamMemberEntity {
  return {
    id: `mem-${userId}`,
    team_id: TEAM,
    user_id: userId,
    role,
    joined_at: "2026-09-01T00:00:00.000Z",
    status: "active",
  };
}

function user(userId: string): UserEntity {
  return {
    user_id: userId,
    password: null,
    auth_provider: "local",
    external_id: userId,
    username: userId,
    display_name: null,
    email: null,
    raw_profile_json: "{}",
    status: "active",
    user_type: "normal",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    metadata_json: "{}",
  };
}

class MemoryMetadataStore {
  assets = new Map<string, AssetEntity>();
  members = new Map<string, TeamMemberEntity>();
  usersByKey = new Map<string, UserEntity>();

  getUserByKey(userKey: string): UserEntity | null {
    return this.usersByKey.get(userKey) ?? null;
  }

  getAssetById(assetId: string): AssetEntity | null {
    return this.assets.get(assetId) ?? null;
  }

  getTeamMember(teamId: string, userId: string): TeamMemberEntity | null {
    return this.members.get(`${teamId}:${userId}`) ?? null;
  }

  listAssetsByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: AssetFilter,
  ): ListPage<AssetEntity> {
    const matched = [...this.assets.values()].filter((row) => {
      if (row.team_id !== teamId) return false;
      if (filter?.asset_type && row.asset_type !== filter.asset_type) return false;
      if (filter?.status && row.status !== filter.status) return false;
      if (filter?.owner_user_id && row.owner_user_id !== filter.owner_user_id) return false;
      if (filter?.visibility && row.visibility !== filter.visibility) return false;
      return true;
    });
    const offset = pagination?.offset ?? 0;
    const limit = pagination?.limit ?? matched.length;
    return { items: matched.slice(offset, offset + limit), total: matched.length };
  }

  listAclByAsset(): ListPage<never> {
    return { items: [], total: 0 };
  }

  updateAsset(assetId: string, patch: Partial<AssetEntity>): AssetEntity | null {
    const current = this.assets.get(assetId);
    if (!current) return null;
    const next = { ...current, ...patch, asset_id: current.asset_id };
    this.assets.set(assetId, next);
    return next;
  }

  deleteAssets(assetIds: string[]): BatchDeleteResult {
    const deleted_ids: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of assetIds) {
      if (this.assets.delete(id)) deleted_ids.push(id);
      else failed.push({ id, reason: "not_found" });
    }
    return { deleted_ids, failed };
  }
}

function setup(): { svc: MetadataService; store: MemoryMetadataStore } {
  const store = new MemoryMetadataStore();
  store.assets.set(PRIV_OWNER, asset({
    asset_id: PRIV_OWNER,
    owner_user_id: OWNER,
    visibility: "private",
    name: "owner-private",
  }));
  store.assets.set(PRIV_SECRET, asset({
    asset_id: PRIV_SECRET,
    owner_user_id: VICTIM,
    visibility: "private",
    name: "victim-secret",
  }));
  store.assets.set(TEAM_SHARED, asset({
    asset_id: TEAM_SHARED,
    owner_user_id: VICTIM,
    visibility: "team",
    name: "team-shared-skill",
  }));
  for (const row of [member(OWNER, "member"), member(VICTIM, "member"), member(ADMIN, "admin")]) {
    store.members.set(`${row.team_id}:${row.user_id}`, row);
  }
  for (const id of [OWNER, VICTIM, ADMIN, STRANGER]) {
    store.usersByKey.set(`sk-mem-${id}`, user(id));
  }
  const svc = new MetadataService(store as unknown as IMetadataStore);
  return { svc, store };
}

const page = { team_id: TEAM, limit: 50, offset: 0 };

describe("asset read auth (#1469)", () => {
  it("denies a stranger get of another team's private asset", async () => {
    const { svc } = setup();
    await expect(svc.getAssetForCaller(PRIV_SECRET, caller(STRANGER))).resolves.toBeNull();
  });

  it("denies a stranger get of another team's team-visible asset", async () => {
    const { svc } = setup();
    await expect(svc.getAssetForCaller(TEAM_SHARED, caller(STRANGER))).resolves.toBeNull();
  });

  it("returns an empty page when a stranger lists another team's assets", async () => {
    const { svc } = setup();
    const listed = await svc.listAssetsForCaller(page, caller(STRANGER));
    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(0);
  });

  it("returns a private asset to its owner", async () => {
    const { svc } = setup();
    const got = await svc.getAssetForCaller(PRIV_SECRET, caller(VICTIM));
    expect(got?.asset_id).toBe(PRIV_SECRET);
    expect(got?.name).toBe("victim-secret");
    expect(got?.visibility).toBe("private");
  });

  it("lists the caller's own private asset and hides other private rows", async () => {
    const { svc } = setup();
    const listed = await svc.listAssetsForCaller(page, caller(OWNER));
    expect(listed.total).toBe(2);
    expect(listed.items.map((row) => row.asset_id).sort()).toEqual([PRIV_OWNER, TEAM_SHARED]);
  });

  it("denies a team admin get of another member's private asset", async () => {
    const { svc } = setup();
    await expect(svc.getAssetForCaller(PRIV_SECRET, caller(ADMIN))).resolves.toBeNull();
  });

  it("omits other members' private assets when a team admin lists the team", async () => {
    const { svc } = setup();
    const listed = await svc.listAssetsForCaller(page, caller(ADMIN));
    expect(listed.items.map((row) => row.asset_id)).toEqual([TEAM_SHARED]);
    expect(listed.total).toBe(1);
  });

  it("lets a teammate read a team-visible asset", async () => {
    const { svc } = setup();
    const got = await svc.getAssetForCaller(TEAM_SHARED, caller(OWNER));
    expect(got?.asset_id).toBe(TEAM_SHARED);
    expect(got?.name).toBe("team-shared-skill");
  });

  it("rejects a stranger update and leaves the private asset unchanged", async () => {
    const { svc, store } = setup();
    await expect(
      svc.updateAssetForCaller(PRIV_SECRET, { name: "hijacked" }, caller(STRANGER)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(store.assets.get(PRIV_SECRET)?.name).toBe("victim-secret");
  });

  it("rejects a team admin update of another member's private asset", async () => {
    const { svc, store } = setup();
    await expect(
      svc.updateAssetForCaller(PRIV_SECRET, { name: "admin-edit" }, caller(ADMIN)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(store.assets.get(PRIV_SECRET)?.name).toBe("victim-secret");
  });

  it("lets the owner update their private asset", async () => {
    const { svc } = setup();
    const updated = await svc.updateAssetForCaller(PRIV_SECRET, { name: "renamed-by-owner" }, caller(VICTIM));
    expect(updated.name).toBe("renamed-by-owner");
    expect(updated.visibility).toBe("private");
  });

  it("rejects a stranger delete and keeps the asset", async () => {
    const { svc, store } = setup();
    await expect(
      svc.deleteAssetsForCaller([PRIV_SECRET], caller(STRANGER)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(store.assets.has(PRIV_SECRET)).toBe(true);
  });

  it("lets the owner delete their private asset", async () => {
    const { svc, store } = setup();
    const result = await svc.deleteAssetsForCaller([PRIV_OWNER], caller(OWNER));
    expect(result.deleted_ids).toEqual([PRIV_OWNER]);
    expect(store.assets.has(PRIV_OWNER)).toBe(false);
    expect(store.assets.has(PRIV_SECRET)).toBe(true);
  });
});

async function postAsset(
  svc: MetadataService,
  pathname: "/v3/meta/asset/get" | "/v3/meta/asset/list" | "/v3/meta/asset/update",
  userId: string,
  body: unknown,
): Promise<{ status: number; payload: { code: number; message: string; data?: unknown } }> {
  let status = 0;
  let payload: { code: number; message: string; data?: unknown } = { code: -1, message: "" };
  const handled = await handleV3MetaRoute(
    {
      headers: {
        "x-tdai-service-id": "default",
        "x-tdai-user-key": `sk-mem-${userId}`,
        "x-request-id": "req-1469",
      },
    } as http.IncomingMessage,
    {} as http.ServerResponse,
    pathname,
    "POST",
    async () => body,
    (_res, code, envelope) => {
      status = code;
      payload = envelope as { code: number; message: string; data?: unknown };
    },
    {
      getMetadataService: () => svc,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  );
  expect(handled).toBe(true);
  return { status, payload };
}

describe("asset/get and asset/list routes (#1469)", () => {
  it("returns 404 when a stranger gets another team's private asset", async () => {
    const { svc } = setup();
    const { status, payload } = await postAsset(svc, "/v3/meta/asset/get", STRANGER, { asset_id: PRIV_SECRET });
    expect(status).toBe(404);
    expect(payload.code).toBe(404);
    expect(payload.message).toContain("asset_not_found");
    expect(JSON.stringify(payload)).not.toContain("victim-secret");
  });

  it("returns an empty page when a stranger lists another team's assets", async () => {
    const { svc } = setup();
    const { status, payload } = await postAsset(svc, "/v3/meta/asset/list", STRANGER, { team_id: TEAM });
    expect(status).toBe(200);
    expect(payload.code).toBe(0);
    expect(payload.data).toMatchObject({ items: [], total: 0 });
  });

  it("returns the private asset when its owner calls asset/get", async () => {
    const { svc } = setup();
    const { status, payload } = await postAsset(svc, "/v3/meta/asset/get", VICTIM, { asset_id: PRIV_SECRET });
    expect(status).toBe(200);
    expect(payload.code).toBe(0);
    expect(payload.data).toMatchObject({
      asset_id: PRIV_SECRET,
      name: "victim-secret",
      visibility: "private",
      owner_user_id: VICTIM,
    });
  });

  it("returns 404 when a team admin gets another member's private asset", async () => {
    const { svc } = setup();
    const { status, payload } = await postAsset(svc, "/v3/meta/asset/get", ADMIN, { asset_id: PRIV_SECRET });
    expect(status).toBe(404);
    expect(payload.code).toBe(404);
    expect(JSON.stringify(payload)).not.toContain("victim-secret");
  });

  it("keeps asset/update owner-only for a stranger and the owner", async () => {
    const { svc, store } = setup();
    const denied = await postAsset(svc, "/v3/meta/asset/update", STRANGER, {
      asset_id: PRIV_SECRET,
      name: "hijacked",
    });
    expect(denied.status).toBe(403);
    expect(denied.payload.code).toBe(403);
    expect(denied.payload.message).toContain("permission_denied");
    expect(store.assets.get(PRIV_SECRET)?.name).toBe("victim-secret");

    const allowed = await postAsset(svc, "/v3/meta/asset/update", VICTIM, {
      asset_id: PRIV_SECRET,
      name: "renamed-by-owner",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.payload.code).toBe(0);
    expect(allowed.payload.data).toMatchObject({ name: "renamed-by-owner", visibility: "private" });
  });
});
