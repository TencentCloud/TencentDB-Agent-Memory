import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateV3, type V3AuthContext } from "../../src/metadata/router/auth.js";
import { MetadataService } from "../../src/metadata/service/metadata-service.js";
import { DuplicateUserKeyError } from "../../src/metadata/store/interface.js";
import { SqliteMetadataStore } from "../../src/metadata/store/sqlite-adapter.js";
import type { AssetVisibility, FixedAssetBindingInput, UserEntity } from "../../src/metadata/types.js";

// Real disk-backed SQLite and real services: no mocked database, permission checks,
// authentication or transactions. Each test owns its databases and removes them.
describe("metadata service / authentication / SQLite integration", () => {
  let directory: string;
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let openStores: SqliteMetadataStore[];
  let owner: UserEntity;
  let reader: UserEntity;
  let admin: UserEntity;
  let ownerCtx: V3AuthContext;
  let readerCtx: V3AuthContext;
  let adminCtx: V3AuthContext;
  let teamId: string;
  let agentId: string;

  function openDatabase(name = "instance-a") {
    const database = new SqliteMetadataStore(join(directory, name, "metadata.db"));
    database.init();
    openStores.push(database);
    return database;
  }

  async function contextFor(user: UserEntity): Promise<V3AuthContext> {
    const key = store.getDefaultUserKey(user.user_id)!;
    const auth = await authenticateV3(key.key_value, service);
    expect(auth.ok).toBe(true);
    return auth.ctx!;
  }

  function reopen() {
    store.close();
    store = openDatabase();
    service = new MetadataService(store, "instance-a");
  }

  function createSkill(assetId: string, visibility: AssetVisibility = "team") {
    return service.createAssetForCaller({
      asset_id: assetId, team_id: teamId, asset_type: "skill", name: assetId,
      owner_user_id: owner.user_id, source_type: "manual", visibility, status: "approved",
    }, ownerCtx);
  }

  function binding(assetId: string): FixedAssetBindingInput {
    return { asset_id: assetId, asset_type: "skill", created_by: owner.user_id };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tdai-metadata-integration-"));
    openStores = [];
    store = openDatabase();
    service = new MetadataService(store, "instance-a");
    owner = store.getUserById((await service.createNormalUser({ username: "owner" })).user_id)!;
    reader = store.getUserById((await service.createNormalUser({ username: "reader" })).user_id)!;
    admin = store.getUserById((await service.createNormalUser({ username: "admin" })).user_id)!;
    teamId = (await service.createTeam({ name: "Alpha", owner_user_id: owner.user_id })).team_id;
    await service.addTeamMember({ team_id: teamId, user_id: reader.user_id, role: "member" });
    await service.addTeamMember({ team_id: teamId, user_id: admin.user_id, role: "admin" });
    ownerCtx = await contextFor(owner);
    readerCtx = await contextFor(reader);
    adminCtx = await contextFor(admin);
    agentId = (await service.createAgentForCaller({
      team_id: teamId, owner_user_id: owner.user_id, name: "Alpha agent",
    }, ownerCtx)).agent_id;
  });

  afterEach(async () => {
    for (const database of openStores ?? []) database.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("persists a restricted ACL across reopen and applies its revocation immediately", async () => {
    const asset = await createSkill("skl-restricted", "restricted");
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toBeNull();
    const acl = await service.grantAclForCaller({
      asset_id: asset.asset_id, subject_type: "user", subject_id: reader.user_id,
      permission: "read", granted_by: owner.user_id,
    }, ownerCtx);
    reopen();
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toMatchObject({ asset_id: asset.asset_id });
    await service.revokeAcl(acl.id);
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toBeNull();
    expect(store.listAclByAsset(asset.asset_id).items).toEqual([]);
  });

  it("honors owner-only privacy even for a team admin, then exposes an explicitly shared asset", async () => {
    const asset = await createSkill("skl-private", "private");
    expect(await service.getAssetForCaller(asset.asset_id, ownerCtx)).toMatchObject({ asset_id: asset.asset_id });
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toBeNull();
    expect(await service.getAssetForCaller(asset.asset_id, adminCtx)).toBeNull();
    await service.updateAssetForCaller(asset.asset_id, { visibility: "team" }, ownerCtx);
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toMatchObject({ visibility: "team" });
    expect(await service.getAssetForCaller(asset.asset_id, adminCtx)).toMatchObject({ visibility: "team" });
  });

  it("revokes access on member removal without deleting the ACL and restores it on rejoin", async () => {
    const asset = await createSkill("skl-membership", "restricted");
    await service.grantAclForCaller({
      asset_id: asset.asset_id, subject_type: "user", subject_id: reader.user_id,
      permission: "read", granted_by: owner.user_id,
    }, ownerCtx);
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).not.toBeNull();
    await service.removeTeamMemberForCaller(teamId, reader.user_id, ownerCtx);
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).toBeNull();
    expect(store.listAclByAsset(asset.asset_id).items).toHaveLength(1);
    await service.addTeamMemberForCaller({ team_id: teamId, user_id: reader.user_id }, ownerCtx);
    expect(await service.getAssetForCaller(asset.asset_id, readerCtx)).not.toBeNull();
  });

  it("filters visible assets before pagination and reports the visible total", async () => {
    await createSkill("skl-public-a");
    await createSkill("skl-hidden-a", "private");
    await createSkill("skl-public-b");
    await createSkill("skl-hidden-b", "private");
    const first = await service.listAssetsForCaller({ team_id: teamId, asset_type: "skill", limit: 1, offset: 0 }, readerCtx);
    const second = await service.listAssetsForCaller({ team_id: teamId, asset_type: "skill", limit: 1, offset: 1 }, readerCtx);
    const exhausted = await service.listAssetsForCaller({ team_id: teamId, asset_type: "skill", limit: 1, offset: 2 }, readerCtx);
    expect([first.total, second.total, exhausted.total]).toEqual([2, 2, 2]);
    expect([...first.items, ...second.items].map((asset) => asset.asset_id).sort()).toEqual(["skl-public-a", "skl-public-b"]);
    expect(exhausted.items).toEqual([]);
  });

  it("rolls back an entire binding replacement when SQLite rejects a duplicate", async () => {
    await createSkill("skl-original");
    await createSkill("skl-replacement");
    await service.setAgentFixedAssetsForCaller(agentId, [binding("skl-original")], ownerCtx);
    const before = (await service.listAgentFixedAssets(agentId)).items;
    await expect(service.setAgentFixedAssetsForCaller(agentId, [binding("skl-replacement"), binding("skl-replacement")], ownerCtx))
      .rejects.toThrow(/UNIQUE constraint failed/);
    expect((await service.listAgentFixedAssets(agentId)).items).toEqual(before);
    reopen();
    expect((await service.listAgentFixedAssets(agentId)).items).toEqual(before);
  });

  it("rejects cross-team bindings and task-agent links before changing existing data", async () => {
    await createSkill("skl-existing");
    await service.setAgentFixedAssetsForCaller(agentId, [binding("skl-existing")], ownerCtx);
    const otherTeam = await service.createTeam({ name: "Beta", owner_user_id: owner.user_id });
    const otherAgent = await service.createAgentForCaller({ team_id: otherTeam.team_id, owner_user_id: owner.user_id, name: "Beta agent" }, ownerCtx);
    await service.createAssetForCaller({
      asset_id: "skl-other-team", team_id: otherTeam.team_id, owner_user_id: owner.user_id,
      asset_type: "skill", name: "Other team skill", source_type: "manual", visibility: "team",
    }, ownerCtx);
    await expect(service.setAgentFixedAssetsForCaller(agentId, [binding("skl-other-team")], ownerCtx))
      .rejects.toMatchObject({ code: "asset_not_bindable" });
    expect((await service.listAgentFixedAssets(agentId)).items.map((entry) => entry.asset_id)).toEqual(["skl-existing"]);
    await expect(service.createTaskForCaller({
      team_id: teamId, creator_user_id: owner.user_id, title: "Cross-team task",
      linked_agents: [{ agent_id: otherAgent.agent_id }],
    }, ownerCtx)).rejects.toMatchObject({ code: "agent_team_mismatch" });
    expect((await service.listTasksByTeam(teamId)).items).toEqual([]);
  });

  it("deletes asset bindings and ACLs durably while leaving another instance untouched", async () => {
    const asset = await createSkill("skl-same-id");
    await service.setAgentFixedAssetsForCaller(agentId, [binding(asset.asset_id)], ownerCtx);
    await service.grantAclForCaller({ asset_id: asset.asset_id, subject_type: "user", subject_id: reader.user_id, permission: "write", granted_by: owner.user_id }, ownerCtx);
    const other = openDatabase("instance-b");
    const otherOwner = other.createUser({ username: "owner", auth_provider: "local", external_id: "owner-instance-b" });
    const otherTeam = other.createTeam({ name: "Independent", owner_user_id: otherOwner.user_id });
    other.createAsset({ asset_id: asset.asset_id, asset_type: "skill", team_id: otherTeam.team_id, owner_user_id: otherOwner.user_id, name: "Independent skill", source_type: "manual" });
    await expect(service.deleteAssetsForCaller([asset.asset_id], ownerCtx)).resolves.toEqual({ deleted_ids: [asset.asset_id], failed: [] });
    reopen();
    expect(await service.getAssetById(asset.asset_id)).toBeNull();
    expect((await service.listAgentFixedAssets(agentId)).items).toEqual([]);
    expect((await service.listAclByAsset(asset.asset_id)).items).toEqual([]);
    expect(other.getAssetById(asset.asset_id)?.name).toBe("Independent skill");
    await expect(service.deleteAssetsForCaller([asset.asset_id], ownerCtx)).resolves.toEqual({ deleted_ids: [asset.asset_id], failed: [] });
  });

  it("persists API-key revocation and promotes the remaining key across reopen", async () => {
    const first = store.getDefaultUserKey(reader.user_id)!;
    const second = store.createUserKey({ user_id: reader.user_id, name: "replacement" });
    await service.revokeUserKey(first.key_id);
    reopen();
    expect(await authenticateV3(first.key_value, service)).toMatchObject({ ok: false, reason: "invalid_user_key" });
    expect(await authenticateV3(second.key_value, service)).toMatchObject({ ok: true, ctx: { userId: reader.user_id } });
    expect(store.getDefaultUserKey(reader.user_id)?.key_id).toBe(second.key_id);
    await expect(service.revokeUserKey(second.key_id)).rejects.toMatchObject({ code: "last_key_cannot_revoke" });
    expect(await authenticateV3(second.key_value, service)).toMatchObject({ ok: true });
  });

  it("rolls back user creation when its requested default API key collides", async () => {
    const key = store.getDefaultUserKey(owner.user_id)!;
    expect(() => store.createUser({ username: "must-roll-back", auth_provider: "local", external_id: "duplicate-key-user", default_key_value: key.key_value })).toThrow(DuplicateUserKeyError);
    expect(store.getUserByUsername("local", "must-roll-back")).toBeNull();
    reopen();
    expect(store.getUserByUsername("local", "must-roll-back")).toBeNull();
    expect(await authenticateV3(key.key_value, service)).toMatchObject({ ok: true, ctx: { userId: owner.user_id } });
  });
});
