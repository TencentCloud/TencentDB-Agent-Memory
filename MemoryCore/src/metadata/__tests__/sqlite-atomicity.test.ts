import { afterEach, beforeEach, expect, it } from 'vitest';
import { SqliteMetadataStore } from '../store/sqlite-adapter.js';
import { buildChatMemoryAssetId } from '../utils/chat-memory-asset.js';
let store: SqliteMetadataStore;
beforeEach(async () => { store = new SqliteMetadataStore(':memory:'); await store.init(); });
afterEach(() => store.close());
async function seed() {
  const u = store.createUser({ auth_provider: 'local', external_id: 'u', username: 'u' });
  const t = store.createTeam({ name: 't', owner_user_id: u.user_id });
  const a = store.createAgent({ team_id: t.team_id, owner_user_id: u.user_id, name: 'a' });
  const memory = buildChatMemoryAssetId(t.team_id, a.agent_id);
  store.createAsset({ asset_id: memory, asset_type: 'chat_memory', team_id: t.team_id, owner_user_id: u.user_id, name: 'memory', source_type: 'auto' });
  return { u, t, a, memory };
}
it('agent cascade failure rolls back child deletions', async () => {
  const f = await seed();
  // SQLite trigger provides deterministic storage failure after child cleanup.
  (store as any).db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON meta_agents BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(() => store.deleteAgents([f.a.agent_id])).toThrow('injected failure');
  expect(store.getAgentById(f.a.agent_id)).not.toBeNull(); expect(store.getAssetById(f.memory)).not.toBeNull();
});
it('team cascade nested savepoints roll back when parent delete fails', async () => {
  const f = await seed();
  (store as any).db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON meta_teams BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(() => store.deleteTeams([f.t.team_id])).toThrow('injected failure');
  expect(store.getAgentById(f.a.agent_id)).not.toBeNull(); expect(store.getAssetById(f.memory)).not.toBeNull(); expect(store.getTeamMember(f.t.team_id, f.u.user_id)).not.toBeNull();
});
it('asset transfer failure rolls back the agent owner CAS', async () => {
  const f = await seed();
  (store as any).db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON meta_assets BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(() => store.transferAgentOwnership(f.a.agent_id, f.u.user_id, 'target')).toThrow('injected failure');
  expect(store.getAgentById(f.a.agent_id)?.owner_user_id).toBe(f.u.user_id); expect(store.getAssetById(f.memory)?.owner_user_id).toBe(f.u.user_id);
});
