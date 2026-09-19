import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoMetadataStore } from '../store/mongodb-adapter.js';
import type { IMetadataStore } from '../store/interface.js';
import { MetadataService } from '../service/metadata-service.js';
import { SqliteMetadataStore } from '../store/sqlite-adapter.js';
import { buildChatMemoryAssetId } from '../utils/chat-memory-asset.js';
import type { V3AuthContext } from '../router/auth.js';

const P = { limit: 100, offset: 0 };
const ctx = (userId: string, isSystemAdmin = false): V3AuthContext => ({ token: 'test', userId, isAdmin: false, isSystemAdmin });
let db: IMetadataStore, svc: MetadataService;
let replica: MongoMemoryReplSet | undefined, mongo: MongoClient | undefined;
let database = '', seq = 0;
beforeAll(async () => {
  if (process.env.TEST_LIFECYCLE_BACKEND === 'mongodb') {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } });
    mongo = await new MongoClient(replica.getUri()).connect();
  }
}, 180_000);
afterAll(async () => { await mongo?.close(); await replica?.stop(); });
let admin: string, owner: string, member: string, otherAdmin: string, team: string, otherTeam: string;
const create = (teamId = team, userId = owner, name = 'agent') => svc.createAgent({ team_id: teamId, owner_user_id: userId, name });
const memory = (id: string, teamId = team) => buildChatMemoryAssetId(teamId, id);

beforeEach(async () => {
  database = `lifecycle_${++seq}`;
  db = mongo ? new MongoMetadataStore(mongo, database, { ownsClient: false }) : new SqliteMetadataStore(':memory:'); await db.init();
  svc = new MetadataService(db);
  const user = async (name: string) => (await db.createUser({ auth_provider: 'local', external_id: name, username: name })).user_id;
  admin = await user('admin'); owner = await user('owner'); member = await user('member'); otherAdmin = await user('other');
  team = (await db.createTeam({ name: 'A', owner_user_id: admin })).team_id;
  otherTeam = (await db.createTeam({ name: 'B', owner_user_id: otherAdmin })).team_id;
  for (const user_id of [owner, member]) await db.addTeamMember({ team_id: team, user_id, role: 'member' });
  await db.addTeamMember({ team_id: otherTeam, user_id: owner, role: 'member' });
});
afterEach(async () => { await db.close(); if (mongo) await mongo.db(database).dropDatabase(); });

for (const operation of ['delete', 'archive'] as const) {
  for (const role of ['owner', 'team-admin', 'system-admin', 'member', 'other-admin'] as const) {
    it(`${operation}: permission matrix ${role}`, async () => {
      const a = await create();
      const caller = ctx(role === 'owner' ? owner : role === 'team-admin' ? admin : role === 'member' ? member : otherAdmin, role === 'system-admin');
      const run = operation === 'delete' ? svc.deleteAgentsForCaller([a.agent_id], caller) : svc.archiveAgentForCaller(a.agent_id, caller);
      if (role === 'member' || role === 'other-admin') {
        await expect(run).rejects.toMatchObject({ code: 'permission_denied' });
        expect((await db.getAgentById(a.agent_id))?.status).toBe('active');
      } else {
        await run;
        expect(await db.getAssetById(memory(a.agent_id))).toBeNull();
        if (operation === 'delete') expect(await db.getAgentById(a.agent_id)).toBeNull();
        else expect((await db.getAgentById(a.agent_id))?.status).toBe('inactive');
      }
    });
  }
}

it('member removal drains 205 agents without deleting another team or owner', async () => {
  for (let i = 0; i < 205; i++) await create(team, owner, `a${i}`);
  const b = await create(otherTeam); const keep = await create(team, member);
  await svc.removeTeamMemberForCaller(team, owner, ctx(admin));
  expect((await db.listAgentsByTeam(team, P, { owner_user_id: owner })).total).toBe(0);
  expect(await db.getTeamMember(team, owner)).toBeNull();
  expect(await db.getAgentById(b.agent_id)).not.toBeNull();
  expect(await db.getAgentById(keep.agent_id)).not.toBeNull();
});
it('user deletion drains across teams and removes authentication keys', async () => {
  const a = await create(); const b = await create(otherTeam);
  await svc.deleteUsersForCaller([owner], ctx(otherAdmin, true));
  for (const id of [a.agent_id, b.agent_id]) expect(await db.getAgentById(id)).toBeNull();
  expect(await db.getUserById(owner)).toBeNull();
  expect((await db.listUserKeys(owner, P)).total).toBe(0);
});
it('content cleanup failure retains owner, membership, agent and asset for retry', async () => {
  const a = await create();
  const clean = vi.fn().mockRejectedValueOnce(new Error('content unavailable')).mockResolvedValue(undefined);
  svc.setChatMemoryContentCleaner(clean);
  await expect(svc.removeTeamMemberForCaller(team, owner, ctx(admin))).rejects.toThrow('content unavailable');
  expect(await db.getTeamMember(team, owner)).not.toBeNull();
  expect(await db.getAgentById(a.agent_id)).not.toBeNull();
  expect(await db.getAssetById(memory(a.agent_id))).not.toBeNull();
  await svc.removeTeamMemberForCaller(team, owner, ctx(admin));
  expect(await db.getAgentById(a.agent_id)).toBeNull();
  expect(clean).toHaveBeenCalledTimes(2);
});
it('partial batch failure never removes parent user', async () => {
  await create();
  vi.spyOn(db, 'deleteAgents').mockReturnValue({ deleted_ids: [], failed: [{ id: 'a', reason: 'disk' }] });
  await expect(svc.deleteUsersForCaller([owner], ctx(admin, true))).rejects.toMatchObject({ code: 'cascade_failed' });
  expect(await db.getUserById(owner)).not.toBeNull();
});
it('hard delete invokes content and skill cleanup before metadata disappears', async () => {
  const a = await create(); const order: string[] = [];
  svc.setAgentSkillCleaner(async () => { order.push('skill'); expect(await db.getAgentById(a.agent_id)).not.toBeNull(); });
  svc.setChatMemoryContentCleaner(async () => { order.push('memory'); expect(await db.getAssetById(memory(a.agent_id))).not.toBeNull(); });
  await svc.deleteAgentsForCaller([a.agent_id], ctx(admin));
  expect(order).toEqual(['skill', 'memory']);
  expect(await db.getAgentById(a.agent_id)).toBeNull();
});
it('team deletion uses content cleaner and removes borrowed memory bindings', async () => {
  const a = await create(); const b = await create(otherTeam);
  await db.setAgentFixedAssets(b.agent_id, [{ asset_id: memory(a.agent_id), asset_type: 'chat_memory', created_by: owner }]);
  const clean = vi.fn().mockResolvedValue(undefined); svc.setChatMemoryContentCleaner(clean);
  await svc.deleteTeamsForCaller([team], ctx(admin));
  expect(clean).toHaveBeenCalledWith({ teamId: team, agentId: a.agent_id });
  expect((await db.listAgentFixedAssets(b.agent_id, P)).total).toBe(0);
  expect(await db.getTeamById(team)).toBeNull();
});
it('batch authorization completes before any deletion', async () => {
  const a = await create(); const b = await create(otherTeam);
  const clean = vi.fn(); svc.setChatMemoryContentCleaner(clean);
  await expect(svc.deleteAgentsForCaller([a.agent_id, b.agent_id], ctx(admin))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(clean).not.toHaveBeenCalled(); expect(await db.getAgentById(a.agent_id)).not.toBeNull();
});
it('protects team owner before cleanup', async () => {
  const a = await create(team, admin);
  await expect(svc.removeTeamMemberForCaller(team, admin, ctx(admin))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await db.getAgentById(a.agent_id)).not.toBeNull();
});

for (const role of ['owner', 'team-admin', 'system-admin'] as const) {
  it(`ownership transfer by ${role} keeps content and bindings; revokes old owner`, async () => {
    const a = await create(); const clean = vi.fn(); svc.setChatMemoryContentCleaner(clean);
    const caller = ctx(role === 'owner' ? owner : role === 'team-admin' ? admin : otherAdmin, role === 'system-admin');
    await svc.transferAgentForCaller(a.agent_id, member, owner, caller);
    expect((await db.getAgentById(a.agent_id))?.owner_user_id).toBe(member);
    expect((await db.getAssetById(memory(a.agent_id)))?.owner_user_id).toBe(member);
    expect((await db.listAgentFixedAssets(a.agent_id, P)).total).toBeGreaterThan(0);
    expect(clean).not.toHaveBeenCalled();
    await expect(svc.deleteAgentsForCaller([a.agent_id], ctx(owner))).rejects.toMatchObject({ code: 'permission_denied' });
    await svc.removeTeamMemberForCaller(team, owner, ctx(admin));
    expect(await db.getAgentById(a.agent_id)).not.toBeNull();
  });
}
it('transfer rejects non-member and stale expected owner without writes', async () => {
  const a = await create();
  await expect(svc.transferAgentForCaller(a.agent_id, otherAdmin, owner, ctx(admin))).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(svc.transferAgentForCaller(a.agent_id, member, 'stale', ctx(admin))).rejects.toMatchObject({ code: 'ownership_conflict' });
  expect((await db.getAgentById(a.agent_id))?.owner_user_id).toBe(owner);
});
it('ordinary update cannot bypass transfer validation', async () => {
  const a = await create();
  await expect(svc.updateAgentForCaller(a.agent_id, { owner_user_id: otherAdmin }, ctx(owner))).rejects.toMatchObject({ code: 'permission_denied' });
});
it('GC defaults to preview; apply rechecks candidates and keeps healthy agents', async () => {
  const a = await create(); const healthy = await create(team, member);
  await db.removeTeamMember(team, owner);
  const preview = await svc.gcAgentsForCaller({ team_id: team }, ctx(admin));
  expect(preview.candidates.map((x) => x.agent_id)).toContain(a.agent_id);
  expect(await db.getAgentById(a.agent_id)).not.toBeNull();
  await db.addTeamMember({ team_id: team, user_id: owner, role: 'member' });
  const apply = await svc.gcAgentsForCaller({ team_id: team, dry_run: false, agent_ids: [a.agent_id, healthy.agent_id] }, ctx(admin));
  expect(apply.deleted_ids).toEqual([]); expect(apply.skipped_ids).toHaveLength(2);
});
it('GC removes historical missing-owner agents, is repeatable and team scoped', async () => {
  const a = await create(); const b = await create(otherTeam);
  await db.deleteUsers([owner]);
  await expect(svc.gcAgentsForCaller({ team_id: team, dry_run: false, agent_ids: [b.agent_id] }, ctx(admin))).rejects.toMatchObject({ code: 'permission_denied' });
  const input = { team_id: team, dry_run: false, agent_ids: [a.agent_id] };
  expect((await svc.gcAgentsForCaller(input, ctx(admin))).deleted_ids).toEqual([a.agent_id]);
  expect((await svc.gcAgentsForCaller(input, ctx(admin))).deleted_ids).toEqual([]);
  expect(await db.getAgentById(b.agent_id)).not.toBeNull();
});
it('GC rejects ordinary member and refuses unbounded destructive sweep', async () => {
  await expect(svc.gcAgentsForCaller({ team_id: team }, ctx(member))).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(svc.gcAgentsForCaller({ team_id: team, dry_run: false }, ctx(admin))).rejects.toMatchObject({ code: 'invalid_input' });
});
it('concurrent creation waits for removal and rechecks target membership', async () => {
  await create();
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
  svc.setChatMemoryContentCleaner(async () => { entered(); await gate; });
  const removing = svc.removeTeamMemberForCaller(team, owner, ctx(admin)); await started;
  const creating = svc.createAgentForCaller({ team_id: team, owner_user_id: owner, name: 'late clone' }, ctx(admin));
  const rejected = expect(creating).rejects.toMatchObject({ code: 'permission_denied' });
  release(); await removing; await rejected;
  expect((await db.listAgentsByOwner(owner, P)).total).toBe(0);
});

it('transfer also moves owned Skill metadata, but not borrowed assets', async () => {
  const a = await create();
  await svc.ensureSkillAsset({ skill_id: 'skl-owned', team_id: team, agent_id: a.agent_id, name: 'own' });
  await db.createAsset({ asset_id: 'skl-borrowed', team_id: team, asset_type: 'skill', name: 'borrowed', owner_user_id: admin, source_type: 'manual' });
  await db.addAgentFixedAsset(a.agent_id, { asset_id: 'skl-borrowed', asset_type: 'skill', created_by: owner });
  svc.setAgentSkillAssetResolver(async () => ['skl-owned']);
  await svc.transferAgentForCaller(a.agent_id, member, owner, ctx(admin));
  expect((await db.getAssetById('skl-owned'))?.owner_user_id).toBe(member);
  expect((await db.getAssetById('skl-borrowed'))?.owner_user_id).toBe(admin);
});
it('two simultaneous transfers use expected owner CAS', async () => {
  const a = await create();
  const results = await Promise.allSettled([
    svc.transferAgentForCaller(a.agent_id, member, owner, ctx(admin)),
    svc.transferAgentForCaller(a.agent_id, admin, owner, ctx(admin)),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect((await db.getAgentById(a.agent_id))?.owner_user_id).toBe(member);
});
it('GC preview paginates without mutation across 205 historical orphans', async () => {
  for (let i = 0; i < 205; i++) await create(team, owner, `gc-${i}`);
  await db.removeTeamMember(team, owner);
  const first = await svc.gcAgentsForCaller({ team_id: team }, ctx(admin));
  const second = await svc.gcAgentsForCaller({ team_id: team, offset: first.next_offset! }, ctx(admin));
  const last = await svc.gcAgentsForCaller({ team_id: team, offset: second.next_offset! }, ctx(admin));
  expect(first.candidates).toHaveLength(100); expect(second.candidates).toHaveLength(100);
  expect(last.candidates).toHaveLength(5); expect(last.next_offset).toBeNull();
  expect((await db.listAgentsByTeam(team, P)).total).toBe(205);
});
it('GC reports cleanup failure, preserves root and succeeds on retry', async () => {
  const a = await create(); await db.removeTeamMember(team, owner);
  svc.setChatMemoryContentCleaner(vi.fn().mockRejectedValueOnce(new Error('retry me')).mockResolvedValue(undefined));
  const input = { team_id: team, dry_run: false, agent_ids: [a.agent_id] };
  const first = await svc.gcAgentsForCaller(input, ctx(admin));
  expect(first.failed).toEqual([{ id: a.agent_id, reason: 'retry me' }]);
  expect(await db.getAgentById(a.agent_id)).not.toBeNull();
  expect((await svc.gcAgentsForCaller(input, ctx(admin))).deleted_ids).toEqual([a.agent_id]);
});
it('Skill cleanup failure aborts archive before memory and status mutation', async () => {
  const a = await create(); const clean = vi.fn(); svc.setChatMemoryContentCleaner(clean);
  svc.setAgentSkillCleaner(async () => { throw new Error('skill unavailable'); });
  await expect(svc.archiveAgentForCaller(a.agent_id, ctx(admin))).rejects.toThrow('skill unavailable');
  expect(clean).not.toHaveBeenCalled(); expect((await db.getAgentById(a.agent_id))?.status).toBe('active');
});
it('store CAS leaves both owners unchanged on stale input', async () => {
  const a = await create();
  expect(await db.transferAgentOwnership(a.agent_id, 'stale', member)).toBeNull();
  expect((await db.getAgentById(a.agent_id))?.owner_user_id).toBe(owner);
  expect((await db.getAssetById(memory(a.agent_id)))?.owner_user_id).toBe(owner);
});
it('empty store batches are no-ops', async () => {
  expect(await db.deleteAgents([])).toEqual({ deleted_ids: [], failed: [] });
  expect(await db.deleteTeams([])).toEqual({ deleted_ids: [], failed: [] });
});
it('last system admin protection happens before cleaning agents', async () => {
  const sys = await db.createUser({ auth_provider: 'local', external_id: 'sys', username: 'sys', user_type: 'system_admin' }); await db.addTeamMember({ team_id: team, user_id: sys.user_id, role: 'member' }); const a = await create(team, sys.user_id);
  await expect(svc.deleteUsersForCaller([sys.user_id], ctx(sys.user_id, true))).rejects.toMatchObject({ code: 'last_system_admin' });
  expect(await db.getAgentById(a.agent_id)).not.toBeNull();
});
it('inactive destination and unrelated caller cannot transfer', async () => {
  const a = await create();
  await expect(svc.transferAgentForCaller(a.agent_id, member, owner, ctx(member))).rejects.toMatchObject({ code: 'permission_denied' });
  await db.updateUser(member, { status: 'inactive' });
  await expect(svc.transferAgentForCaller(a.agent_id, member, owner, ctx(admin))).rejects.toMatchObject({ code: 'permission_denied' });
});
it('agent read/list hide private agents from other members before pagination', async () => {
  const a = await create(); await db.updateAgent(a.agent_id, { visibility: 'private' });
  const shared = await create(team, admin);
  const list = await svc.listAgentsForCaller(team, undefined, {}, { limit: 1, offset: 0 }, ctx(member));
  expect(list.total).toBe(1); expect(list.items[0]?.agent_id).toBe(shared.agent_id);
  await expect(svc.getAgentForCaller(a.agent_id, ctx(member))).rejects.toMatchObject({ code: 'permission_denied' });
  expect((await svc.getAgentForCaller(a.agent_id, ctx(admin))).agent_id).toBe(a.agent_id);
  expect((await svc.listAgentsForCaller(team, undefined, {}, P, ctx(otherAdmin, true))).total).toBe(2);
  await expect(svc.listAgentsForCaller(team, undefined, {}, P, ctx(otherAdmin))).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(svc.listAgentsForCaller(undefined, owner, {}, P, ctx(member))).rejects.toMatchObject({ code: 'permission_denied' });
});
it('system admin outside team may remove a member', async () => {
  const a = await create(); await svc.removeTeamMemberForCaller(team, owner, ctx(otherAdmin, true));
  expect(await db.getAgentById(a.agent_id)).toBeNull();
});
