import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPanelConfig } from '../../src/panel/config/panel-config.js';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { mapHttpStatusFromEnvelopeCode } from '../../src/panel/kernel/envelope.js';
import { META_HEADER_SERVICE_ID, META_HEADER_USER_KEY } from '../../src/panel/kernel/headers.js';
import { buildPanelDeps } from '../../src/panel/panel-deps.js';

const INSTANCE_ID = 'inst-e2e';
const GATEWAY_API_KEY = 'test-gateway-key';
const OWNER_KEY = 'test-owner-key';

interface Envelope {
  code: number;
  message: string;
  data: unknown;
}

interface MockState {
  skillCoreEnabled: boolean;
  agentStatus: string;
  skills: Map<string, { skill_id: string; version: number; owner_agent_id: string }>;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  skillListOverride?: (offset: number) => Envelope | undefined;
  skillDeleteOverride?: (skillId: string) => Envelope | undefined;
}

function sendJson(res: http.ServerResponse, env: Envelope): void {
  res.writeHead(mapHttpStatusFromEnvelopeCode(env.code), { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...env, request_id: 'mock-req' }));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startGateway(state: MockState): Promise<{ server: http.Server; endpoint: string }> {
  const server = http.createServer(async (req, res) => {
    const reqPath = req.url ?? '';
    const body = await readBody(req);
    state.calls.push({ path: reqPath, body });

    if (reqPath === '/v3/meta/auth/verify') {
      return sendJson(res, { code: 0, message: 'ok', data: { valid: true, user: { user_id: 'usr-owner' } } });
    }
    if (reqPath === '/v3/meta/agent/get') {
      return sendJson(res, {
        code: 0,
        message: 'ok',
        data: { agent_id: 'agt-1', team_id: 'team-1', owner_user_id: 'usr-owner', status: state.agentStatus },
      });
    }
    if (reqPath === '/v3/meta/agent/archive') {
      state.agentStatus = 'archived';
      return sendJson(res, { code: 0, message: 'ok', data: { agent_id: 'agt-1', status: 'archived' } });
    }
    if (reqPath === '/v3/skill/list') {
      const offset = (body.pagination as { offset?: number } | undefined)?.offset ?? 0;
      const limit = (body.pagination as { limit?: number } | undefined)?.limit ?? 100;
      const overridden = state.skillListOverride?.(offset);
      if (overridden) return sendJson(res, overridden);
      if (!state.skillCoreEnabled) {
        return sendJson(res, { code: 404, message: 'Skill module not enabled', data: null });
      }
      const all = [...state.skills.values()];
      return sendJson(res, { code: 0, message: 'ok', data: { items: all.slice(offset, offset + limit), total: all.length } });
    }
    if (reqPath === '/v3/skill/delete') {
      const skillId = String(body.skill_id ?? '');
      const overridden = state.skillDeleteOverride?.(skillId);
      if (overridden) return sendJson(res, overridden);
      state.skills.delete(skillId);
      return sendJson(res, { code: 0, message: 'ok', data: { skill_id: skillId, archived: true } });
    }
    sendJson(res, { code: 404, message: `UNHANDLED:${reqPath}`, data: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('POST /api/v1/agent/delete-cascade', () => {
  let state: MockState;
  let gateway: http.Server;
  let panel: ReturnType<typeof serve>;
  let panelUrl: string;
  let workDir: string;
  let savedEnv: Record<string, string | undefined>;

  async function deleteCascade() {
    const res = await fetch(`${panelUrl}/api/v1/agent/delete-cascade`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [META_HEADER_SERVICE_ID]: INSTANCE_ID,
        [META_HEADER_USER_KEY]: OWNER_KEY,
      },
      body: JSON.stringify({ agent_id: 'agt-1' }),
    });
    return { status: res.status, body: (await res.json()) as Envelope };
  }

  beforeEach(async () => {
    state = { skillCoreEnabled: true, agentStatus: 'active', skills: new Map(), calls: [] };
    const gw = await startGateway(state);
    gateway = gw.server;

    workDir = mkdtempSync(path.join(tmpdir(), 'panel-cascade-'));
    const instancesFile = path.join(workDir, 'instances.json');
    writeFileSync(
      instancesFile,
      JSON.stringify({ instances: [{ id: INSTANCE_ID, name: 'Test', gateway_endpoint: gw.endpoint, api_key: GATEWAY_API_KEY }] }),
    );

    const envKeys = ['METADATA_INSTANCES_CONFIG', 'LOG_LEVEL', 'UI_DIST_DIR', 'PANEL_AGENT_TEMPLATE_DIR', 'PANEL_AUTH_IDENTITY_STORE_PATH'];
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.METADATA_INSTANCES_CONFIG = instancesFile;
    process.env.LOG_LEVEL = 'error';
    process.env.UI_DIST_DIR = workDir;
    process.env.PANEL_AGENT_TEMPLATE_DIR = path.join(workDir, 'templates');
    process.env.PANEL_AUTH_IDENTITY_STORE_PATH = path.join(workDir, 'identities.json');

    const deps = buildPanelDeps(loadPanelConfig());
    deps.userIdResolver.warm(OWNER_KEY, 'usr-owner', INSTANCE_ID);
    const app = buildPanelApp(deps);
    panel = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      if (panel.listening) resolve();
      else panel.once('listening', () => resolve());
    });
    panelUrl = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => panel.close(() => resolve()));
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('archives agent when SkillCore is disabled (404 "Skill module not enabled")', async () => {
    state.skillCoreEnabled = false;
    const res = await deleteCascade();
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({ archived: true, agent_id: 'agt-1', deleted_skill_count: 0, deleted_skill_ids: [] });
    expect(state.agentStatus).toBe('archived');
    expect(state.calls.map((c) => c.path)).toEqual([
      '/v3/meta/auth/verify',
      '/v3/meta/agent/get',
      '/v3/skill/list',
      '/v3/meta/agent/archive',
    ]);
  });

  it.each([
    { label: 'other 404 message', offset: 0, env: { code: 404, message: 'Not Found', data: null }, expectedStatus: 404 },
    { label: 'non-404 with same message', offset: 0, env: { code: 500, message: 'Skill module not enabled', data: null }, expectedStatus: 500 },
    { label: 'disabled 404 on offset > 0', offset: 100, env: { code: 404, message: 'Skill module not enabled', data: null }, expectedStatus: 404 },
  ])('fails closed without archiving on $label', async ({ offset, env, expectedStatus }) => {
    if (offset > 0) {
      for (let i = 1; i <= 105; i += 1) {
        state.skills.set(`skl-${i}`, { skill_id: `skl-${i}`, version: 1, owner_agent_id: 'agt-1' });
      }
    }
    state.skillListOverride = (reqOffset) => (reqOffset === offset ? env : undefined);

    const res = await deleteCascade();
    expect(res.status).toBe(expectedStatus);
    expect(res.body.code).toBe(env.code);
    expect(state.agentStatus).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
    expect(state.calls.some((c) => c.path === '/v3/skill/delete')).toBe(false);
  });

  it('deletes all paginated skills before archiving when SkillCore is enabled', async () => {
    for (let i = 1; i <= 102; i += 1) {
      state.skills.set(`skl-${i}`, { skill_id: `skl-${i}`, version: 1, owner_agent_id: 'agt-1' });
    }
    const res = await deleteCascade();
    expect(res.status).toBe(200);
    expect((res.body.data as { deleted_skill_count: number }).deleted_skill_count).toBe(102);
    expect(state.skills.size).toBe(0);
    expect(state.agentStatus).toBe('archived');
    const paths = state.calls.map((c) => c.path);
    expect(paths.lastIndexOf('/v3/skill/delete')).toBeLessThan(paths.indexOf('/v3/meta/agent/archive'));
  });

  it('aborts with 500 SKILL_DELETE_FAILED and keeps agent active if skill/delete fails', async () => {
    state.skills.set('skl-1', { skill_id: 'skl-1', version: 1, owner_agent_id: 'agt-1' });
    state.skills.set('skl-2', { skill_id: 'skl-2', version: 1, owner_agent_id: 'agt-1' });
    state.skillDeleteOverride = (id) => (id === 'skl-2' ? { code: 500, message: 'DELETE_ERR', data: null } : undefined);

    const res = await deleteCascade();
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('SKILL_DELETE_FAILED');
    expect(res.body.data).toMatchObject({ failed_skill_id: 'skl-2', deleted_skill_ids: ['skl-1'] });
    expect(state.agentStatus).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });
});
