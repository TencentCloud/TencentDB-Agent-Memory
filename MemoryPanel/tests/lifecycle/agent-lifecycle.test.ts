import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerAgentLifecycleRoutes } from '../../src/panel/http/routes/agent-lifecycle.js';
import { canManageAgentLifecycle } from '../../web/src/services/agent-permissions.js';
import { ALLOWED_PANEL_ACTIONS } from '../../src/panel/api/meta-actions.js';
function fixture(code = 0) {
  const invoke = vi.fn(async () => ({ code, message: code ? 'denied' : 'ok', request_id: 'test', data: { deleted_skill_ids: ['s1', 's2'] } }));
  const deps = { auth: { resolveSession: () => null }, config: { auth: { sessionCookieName: 'fixture' } }, metaKernel: { invoke }, instanceRegistry: { resolve: () => ({ instance_id: 'test', gateway_endpoint: 'http://unused', api_key: 'fixture' }) } };
  const app = new Hono(); registerAgentLifecycleRoutes(app, deps as any);
  const request = (body: unknown = { agent_id: 'a' }, key = 'fixture-key') => app.request('/agent/delete-cascade', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'test', 'x-tdai-user-key': key }, body: JSON.stringify(body) });
  return { invoke, request };
}
it('delegates authorization and cleanup once to kernel without owner impersonation', async () => {
  const f = fixture(); const response = await f.request(); expect(response.status).toBe(200);
  expect((await response.json()).data).toEqual({ archived: true, agent_id: 'a', deleted_skill_count: 2, deleted_skill_ids: ['s1', 's2'] });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.invoke).toHaveBeenCalledWith('agent/archive', { agent_id: 'a' }, expect.objectContaining({ userKey: 'fixture-key' }));
});
it.each([401, 403, 404, 500])('preserves kernel failure %s', async (code) => {
  expect((await fixture(code).request()).status).toBe(code);
});
it('validates input and user key before invoking kernel', async () => {
  const f = fixture(); expect((await f.request({})).status).toBe(400);
  expect((await f.request({ agent_id: 'a' }, '')).status).toBe(400); expect(f.invoke).not.toHaveBeenCalled();
});
it('exposes transfer and GC through the existing metadata proxy', () => {
  expect(ALLOWED_PANEL_ACTIONS.has('agent/transfer')).toBe(true); expect(ALLOWED_PANEL_ACTIONS.has('agent/gc')).toBe(true);
});
describe('Agent-specific UI permission matrix', () => {
  const agent = { owner_user_id: 'owner', team_id: 'team' };
  const team = { team_id: 'team', owner_user_id: 'admin', members: [{ user_id: 'admin', role: 'admin' }, { user_id: 'inactive', role: 'admin', status: 'inactive' }] };
  it.each([['owner', false, true], ['admin', false, true], ['outsider', true, true], ['outsider', false, false], ['inactive', false, false], ['', true, false]] as const)('%s system=%s => %s', (user, system, expected) => {
    expect(canManageAgentLifecycle(agent, team, user, system)).toBe(expected);
  });
  it('another team admin does not gain privileges', () => { expect(canManageAgentLifecycle(agent, { ...team, team_id: 'other' }, 'admin')).toBe(false); });
});
