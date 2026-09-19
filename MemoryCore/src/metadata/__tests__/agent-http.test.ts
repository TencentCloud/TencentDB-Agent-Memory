import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore } from '../store/sqlite-adapter.js';
import { MetadataService } from '../service/metadata-service.js';
import { handleV3MetaRoute } from '../router/v3-meta-router.js';

let store: SqliteMetadataStore, service: MetadataService, server: Server, base: string;
let owner: string, member: string, team: string, key: string, memberKey: string, sysKey: string;
beforeEach(async () => {
  store = new SqliteMetadataStore(':memory:'); await store.init(); service = new MetadataService(store);
  const a = store.createUser({ username: 'owner', auth_provider: 'local', external_id: 'owner' }); owner = a.user_id;
  const b = store.createUser({ username: 'member', auth_provider: 'local', external_id: 'member' }); member = b.user_id;
  const sys = store.createUser({ username: 'system', auth_provider: 'local', external_id: 'system', user_type: 'system_admin' });
  key = store.getDefaultUserKey(owner)!.key_value; memberKey = store.getDefaultUserKey(member)!.key_value; sysKey = store.getDefaultUserKey(sys.user_id)!.key_value;
  team = store.createTeam({ name: 'team', owner_user_id: owner }).team_id;
  store.addTeamMember({ team_id: team, user_id: member, role: 'member' });
  server = createServer(async (req, res) => {
    const handled = await handleV3MetaRoute(req, res, req.url!, req.method!, async <T>(request: IncomingMessage): Promise<T> => {
      let raw = ''; for await (const chunk of request) raw += chunk; return JSON.parse(raw);
    }, (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }, {
      getMetadataService: () => service, logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/meta/`;
});
afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); await store?.close(); });
async function post(action: string, body: unknown, userKey = key) {
  const response = await fetch(base + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'default', 'x-tdai-user-key': userKey }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
it('real HTTP authentication, transfer and stale-owner 409', async () => {
  const a = await service.createAgent({ team_id: team, owner_user_id: owner, name: 'a' });
  const payload = { agent_id: a.agent_id, new_owner_user_id: member, expected_owner_user_id: owner };
  expect((await post('agent/transfer', payload, 'invalid')).status).toBe(401);
  expect((await post('agent/transfer', payload, memberKey)).status).toBe(403);
  expect((await post('agent/transfer', payload)).status).toBe(200);
  expect((await post('agent/transfer', payload)).status).toBe(409);
});
it('GC HTTP defaults read-only and requires explicit IDs for apply', async () => {
  const a = await service.createAgent({ team_id: team, owner_user_id: member, name: 'a' });
  store.removeTeamMember(team, member);
  const preview = await post('agent/gc', { team_id: team });
  expect(preview.status).toBe(200); expect(preview.body.data.dry_run).toBe(true);
  expect(preview.body.data.candidates[0].agent_id).toBe(a.agent_id);
  expect((await post('agent/gc', { team_id: team, dry_run: false })).status).toBe(400);
  expect((await post('agent/gc', { team_id: team, dry_run: false, agent_ids: [a.agent_id] })).body.data.deleted_ids).toEqual([a.agent_id]);
});
it('non-team system admin can archive; ordinary non-owner gets 403', async () => {
  const a = await service.createAgent({ team_id: team, owner_user_id: owner, name: 'a' });
  expect((await post('agent/archive', { agent_id: a.agent_id }, memberKey)).status).toBe(403);
  expect((await post('agent/archive', { agent_id: a.agent_id }, sysKey)).status).toBe(200);
});
it('private Agent is hidden by HTTP get/list, including pagination totals', async () => {
  const a = await service.createAgent({ team_id: team, owner_user_id: owner, name: 'private', visibility: 'private' });
  expect((await post('agent/get', { agent_id: a.agent_id }, memberKey)).status).toBe(403);
  const list = await post('agent/list', { team_id: team }, memberKey);
  expect(list.body.data.total).toBe(0); expect(list.body.data.items).toEqual([]);
});
