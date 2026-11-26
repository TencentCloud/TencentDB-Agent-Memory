import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { loadPanelConfig } from '../../src/panel/config/panel-config.js';
import { buildPanelDeps } from '../../src/panel/panel-deps.js';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { mapHttpStatusFromEnvelopeCode } from '../../src/panel/kernel/envelope.js';
import {
  META_HEADER_REQUEST_ID,
  META_HEADER_SERVICE_ID,
  META_HEADER_USER_KEY,
} from '../../src/panel/kernel/headers.js';

const INSTANCE_ID = 'test-instance';
const GATEWAY_API_KEY = 'test-api-key';
const OWNER_USER_KEY = 'test-user-key-owner';
const OTHER_USER_KEY = 'test-user-key-other';
const INVALID_USER_KEY = 'test-user-key-invalid';

const CONTROLLED_ENV_KEYS = [
  'HOST',
  'PORT',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'METADATA_INSTANCES_CONFIG',
  'METADATA_REMOTE_TIMEOUT_MS',
  'UI_DIST_DIR',
  'KNOWLEDGE_SERVICE_URL',
  'KNOWLEDGE_AUTH_TOKEN',
  'KNOWLEDGE_TIMEOUT_MS',
  'KNOWLEDGE_LLM_BINDING_SYNC',
  'KNOWLEDGE_LLM_PROXY_BASE_URL',
  'TDAI_AGENT_TEMPLATE_DIR',
  'PANEL_FEATURE_ANALYTICS_ENABLED',
  'PANEL_CLICKHOUSE_ENABLED',
  'PANEL_CLICKHOUSE_URL',
  'PANEL_AUTH_MODE',
  'PANEL_AUTH_USER_KEY_ENABLED',
  'PANEL_AUTH_IDP_ENABLED',
  'PANEL_AUTH_IDP_WOA_ENABLED',
  'PANEL_AUTH_IDENTITY_STORE_PATH',
] as const;

interface MockAgent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  status: 'active' | 'archived';
  name: string;
}

interface MockSkill {
  skill_id: string;
  version: number;
  owner_agent_id: string;
  team_id: string;
  status: 'active' | 'archived';
}

interface RecordedKernelCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface EnvelopeResponse {
  httpStatus?: number;
  code: number;
  message: string;
  data: unknown;
}

interface MockGatewayState {
  skillCoreEnabled: boolean;
  usersByKey: Map<string, { user_id: string; username: string; user_type: string }>;
  agents: Map<string, MockAgent>;
  skills: Map<string, MockSkill>;
  calls: RecordedKernelCall[];
  skillListOverride?: (
    body: Record<string, unknown>,
    offset: number,
  ) => EnvelopeResponse | undefined;
  skillDeleteOverride?: (
    body: Record<string, unknown>,
  ) => EnvelopeResponse | undefined;
}

function createMockGatewayState(): MockGatewayState {
  return {
    skillCoreEnabled: true,
    usersByKey: new Map([
      [OWNER_USER_KEY, { user_id: 'usr-owner', username: 'owner', user_type: 'user' }],
      [OTHER_USER_KEY, { user_id: 'usr-other', username: 'other', user_type: 'user' }],
    ]),
    agents: new Map([
      [
        'agt-1',
        {
          agent_id: 'agt-1',
          team_id: 'team-1',
          owner_user_id: 'usr-owner',
          status: 'active',
          name: 'agent-one',
        },
      ],
    ]),
    skills: new Map(),
    calls: [],
  };
}

function seedSkills(state: MockGatewayState, agentId: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const skillId = `skl-${String(i).padStart(3, '0')}`;
    state.skills.set(skillId, {
      skill_id: skillId,
      version: i,
      owner_agent_id: agentId,
      team_id: 'team-1',
      status: 'active',
    });
    ids.push(skillId);
  }
  return ids;
}

function readRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendEnvelope(
  res: http.ServerResponse,
  requestId: string,
  payload: EnvelopeResponse,
): void {
  let status: number;
  if (payload.httpStatus !== undefined) {
    status = payload.httpStatus;
  } else {
    status = mapHttpStatusFromEnvelopeCode(payload.code);
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      code: payload.code,
      message: payload.message,
      request_id: requestId,
      data: payload.data,
    }),
  );
}

async function startMockKernelGateway(state: MockGatewayState): Promise<{
  server: http.Server;
  endpoint: string;
}> {
  const server = http.createServer(async (req, res) => {
    const path = req.url ?? '';
    const requestId = String(req.headers[META_HEADER_REQUEST_ID] ?? 'mock-req-id');
    const body = await readRequestBody(req);
    state.calls.push({ path, headers: req.headers, body });

    if (req.headers.authorization !== `Bearer ${GATEWAY_API_KEY}`) {
      sendEnvelope(res, requestId, { code: 401, message: 'INVALID_API_KEY', data: null });
      return;
    }

    if (path === '/v3/meta/auth/verify') {
      let userKey = '';
      if (typeof body.user_key === 'string') {
        userKey = body.user_key;
      }
      const user = state.usersByKey.get(userKey);
      if (!user) {
        sendEnvelope(res, requestId, { code: 0, message: 'ok', data: { valid: false } });
        return;
      }
      sendEnvelope(res, requestId, { code: 0, message: 'ok', data: { valid: true, user } });
      return;
    }

    if (path === '/v3/meta/agent/get') {
      const agentId = String(body.agent_id ?? '');
      const agent = state.agents.get(agentId);
      if (!agent) {
        sendEnvelope(res, requestId, { code: 404, message: 'AGENT_NOT_FOUND', data: null });
        return;
      }
      sendEnvelope(res, requestId, { code: 0, message: 'ok', data: { ...agent } });
      return;
    }

    if (path === '/v3/meta/agent/archive') {
      const agentId = String(body.agent_id ?? '');
      const agent = state.agents.get(agentId);
      if (!agent) {
        sendEnvelope(res, requestId, { code: 404, message: 'AGENT_NOT_FOUND', data: null });
        return;
      }
      agent.status = 'archived';
      sendEnvelope(res, requestId, { code: 0, message: 'ok', data: { ...agent } });
      return;
    }

    if (path === '/v3/skill/list') {
      const pagination = (body.pagination as { limit?: number; offset?: number } | undefined) ?? {};
      const limit = pagination.limit ?? 100;
      const offset = pagination.offset ?? 0;

      if (state.skillListOverride) {
        const overridden = state.skillListOverride(body, offset);
        if (overridden) {
          sendEnvelope(res, requestId, overridden);
          return;
        }
      }

      if (!state.skillCoreEnabled) {
        sendEnvelope(res, requestId, {
          httpStatus: 404,
          code: 404,
          message: 'Skill module not enabled',
          data: null,
        });
        return;
      }

      const agentId = String(body.agent_id ?? '');
      const activeSkills = [...state.skills.values()].filter(
        (skill) => skill.owner_agent_id === agentId && skill.status === 'active',
      );
      const items = activeSkills.slice(offset, offset + limit);
      sendEnvelope(res, requestId, {
        code: 0,
        message: 'ok',
        data: { items, total: activeSkills.length },
      });
      return;
    }

    if (path === '/v3/skill/delete') {
      if (state.skillDeleteOverride) {
        const overridden = state.skillDeleteOverride(body);
        if (overridden) {
          sendEnvelope(res, requestId, overridden);
          return;
        }
      }

      if (!state.skillCoreEnabled) {
        sendEnvelope(res, requestId, {
          httpStatus: 404,
          code: 404,
          message: 'Skill module not enabled',
          data: null,
        });
        return;
      }

      const skillId = String(body.skill_id ?? '');
      const skill = state.skills.get(skillId);
      if (!skill) {
        sendEnvelope(res, requestId, { code: 404, message: 'SKILL_NOT_FOUND', data: null });
        return;
      }
      state.skills.delete(skillId);
      sendEnvelope(res, requestId, {
        code: 0,
        message: 'ok',
        data: { skill_id: skillId, archived: true },
      });
      return;
    }

    sendEnvelope(res, requestId, { code: 404, message: `UNHANDLED_PATH:${path}`, data: null });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) {
    snapshot.set(key, process.env[key]);
  }
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function startPanelServer(
  workDir: string,
  gatewayEndpoint: string,
): Promise<{
  server: ServerType;
  baseUrl: string;
}> {
  const instancesPath = join(workDir, 'metadata-instances.json');
  writeFileSync(
    instancesPath,
    JSON.stringify({
      instances: [
        {
          id: INSTANCE_ID,
          name: 'Test Instance',
          gateway_endpoint: gatewayEndpoint,
          api_key: GATEWAY_API_KEY,
        },
      ],
    }),
    'utf8',
  );

  const envSnapshot = captureEnv(CONTROLLED_ENV_KEYS);
  try {
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '0';
    process.env.LOG_LEVEL = 'error';
    process.env.LOG_FORMAT = 'json';
    process.env.METADATA_INSTANCES_CONFIG = instancesPath;
    process.env.METADATA_REMOTE_TIMEOUT_MS = '5000';
    process.env.UI_DIST_DIR = workDir;
    process.env.KNOWLEDGE_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.KNOWLEDGE_AUTH_TOKEN = '';
    process.env.KNOWLEDGE_TIMEOUT_MS = '1000';
    process.env.KNOWLEDGE_LLM_BINDING_SYNC = 'false';
    process.env.KNOWLEDGE_LLM_PROXY_BASE_URL = 'http://127.0.0.1:1';
    process.env.TDAI_AGENT_TEMPLATE_DIR = join(workDir, 'agent-templates');
    process.env.PANEL_FEATURE_ANALYTICS_ENABLED = 'false';
    process.env.PANEL_CLICKHOUSE_ENABLED = 'false';
    process.env.PANEL_CLICKHOUSE_URL = '';
    process.env.PANEL_AUTH_MODE = 'user_key';
    process.env.PANEL_AUTH_USER_KEY_ENABLED = 'true';
    process.env.PANEL_AUTH_IDP_ENABLED = 'false';
    process.env.PANEL_AUTH_IDP_WOA_ENABLED = 'false';
    process.env.PANEL_AUTH_IDENTITY_STORE_PATH = join(workDir, 'panel-auth-identities.json');

    const config = loadPanelConfig();
    const deps = buildPanelDeps(config);
    // 预热已知测试 key，避免审计中间件在响应后异步补发 auth/verify 干扰调用顺序断言
    deps.userIdResolver.warm(OWNER_USER_KEY, 'usr-owner', INSTANCE_ID);
    deps.userIdResolver.warm(OTHER_USER_KEY, 'usr-other', INSTANCE_ID);
    const app = buildPanelApp(deps);

    const server = await new Promise<ServerType>((resolve) => {
      const srv = serve(
        { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
        () => resolve(srv),
      );
    });
    const address = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  } finally {
    restoreEnv(envSnapshot);
  }
}

function closeServer(server: http.Server | ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for background request to settle');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /api/v1/agent/delete-cascade (E2E)', () => {
  let workDir: string;
  let state: MockGatewayState;
  let gatewayServer: http.Server;
  let panelServer: ServerType;
  let panelBaseUrl: string;

  async function callDeleteCascade(
    body: Record<string, unknown>,
    userKey = OWNER_USER_KEY,
  ): Promise<{
    status: number;
    json: { code: number; message: string; request_id: string; data: unknown };
  }> {
    const resp = await fetch(`${panelBaseUrl}/api/v1/agent/delete-cascade`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [META_HEADER_SERVICE_ID]: INSTANCE_ID,
        [META_HEADER_USER_KEY]: userKey,
        [META_HEADER_REQUEST_ID]: 'e2e-req-1',
      },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as {
      code: number;
      message: string;
      request_id: string;
      data: unknown;
    };
    return { status: resp.status, json };
  }

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'panel-cascade-'));
    state = createMockGatewayState();
    const gw = await startMockKernelGateway(state);
    gatewayServer = gw.server;
    const panel = await startPanelServer(workDir, gw.endpoint);
    panelServer = panel.server;
    panelBaseUrl = panel.baseUrl;
  });

  afterEach(async () => {
    try {
      await closeServer(panelServer);
    } finally {
      try {
        await closeServer(gatewayServer);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  it('archives agent when SkillCore is disabled (404 "Skill module not enabled")', async () => {
    state.skillCoreEnabled = false;

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        archived: true,
        agent_id: 'agt-1',
        deleted_skill_count: 0,
        deleted_skill_ids: [],
      },
    });
    expect(state.agents.get('agt-1')?.status).toBe('archived');
    expect(state.calls.map((c) => c.path)).toEqual([
      '/v3/meta/auth/verify',
      '/v3/meta/agent/get',
      '/v3/skill/list',
      '/v3/meta/agent/archive',
    ]);
    const skillListCall = state.calls.find((c) => c.path === '/v3/skill/list');
    expect(skillListCall?.headers.authorization).toBe(`Bearer ${GATEWAY_API_KEY}`);
    expect(skillListCall?.headers[META_HEADER_SERVICE_ID]).toBe(INSTANCE_ID);
    expect(skillListCall?.headers[META_HEADER_USER_KEY]).toBe(OWNER_USER_KEY);
  });

  it.each(['Not Found', 'skill module not enabled'])(
    'fails closed when /v3/skill/list returns a different 404 message: %s',
    async (msg) => {
      state.skillListOverride = () => ({
        httpStatus: 404,
        code: 404,
        message: msg,
        data: null,
      });

      const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

      expect(status).toBe(404);
      expect(json.code).toBe(404);
      expect(json.message).toBe(msg);
      expect(state.agents.get('agt-1')?.status).toBe('active');
      expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
    },
  );

  it('fails closed when /v3/skill/list returns 500', async () => {
    state.skillListOverride = () => ({
      httpStatus: 500,
      code: 500,
      message: 'INTERNAL_SKILL_ERROR',
      data: null,
    });

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(500);
    expect(json.code).toBe(500);
    expect(json.message).toBe('INTERNAL_SKILL_ERROR');
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('fails closed when paginated /v3/skill/list returns Skill module disabled on offset > 0', async () => {
    seedSkills(state, 'agt-1', 105);
    state.skillListOverride = (_body, offset) => {
      if (offset === 100) {
        return {
          httpStatus: 404,
          code: 404,
          message: 'Skill module not enabled',
          data: null,
        };
      }
      return undefined;
    };

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(404);
    expect(json.code).toBe(404);
    expect(json.message).toBe('Skill module not enabled');
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/skill/delete')).toBe(false);
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
    expect(state.skills.size).toBe(105);
  });

  it('fails closed when /v3/skill/list returns skills but /v3/skill/delete returns 404 "Skill module not enabled"', async () => {
    seedSkills(state, 'agt-1', 2);
    state.skillDeleteOverride = () => ({
      httpStatus: 404,
      code: 404,
      message: 'Skill module not enabled',
      data: null,
    });

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(500);
    expect(json).toMatchObject({
      code: 500,
      message: 'SKILL_DELETE_FAILED',
      data: {
        failed_skill_id: 'skl-001',
        kernel_code: 404,
        kernel_message: 'Skill module not enabled',
        deleted_skill_ids: [],
      },
    });
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.skills.size).toBe(2);
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('archives agent when SkillCore is enabled and agent has no skills', async () => {
    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        archived: true,
        agent_id: 'agt-1',
        deleted_skill_count: 0,
        deleted_skill_ids: [],
      },
    });
    expect(state.agents.get('agt-1')?.status).toBe('archived');
    expect(state.calls.map((c) => c.path)).toEqual([
      '/v3/meta/auth/verify',
      '/v3/meta/agent/get',
      '/v3/skill/list',
      '/v3/meta/agent/archive',
    ]);
  });

  it('deletes all paginated skills (102 items across 2 pages) before archiving agent', async () => {
    const expectedIds = seedSkills(state, 'agt-1', 102);

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        archived: true,
        agent_id: 'agt-1',
        deleted_skill_count: 102,
        deleted_skill_ids: expectedIds,
      },
    });
    expect(state.agents.get('agt-1')?.status).toBe('archived');
    expect(state.skills.size).toBe(0);

    const paths = state.calls.map((c) => c.path);
    expect(paths.slice(0, 4)).toEqual([
      '/v3/meta/auth/verify',
      '/v3/meta/agent/get',
      '/v3/skill/list',
      '/v3/skill/list',
    ]);
    expect(paths.slice(4, 106)).toEqual(Array(102).fill('/v3/skill/delete'));
    expect(paths[106]).toBe('/v3/meta/agent/archive');
    expect(paths).toHaveLength(107);

    const listOffsets = state.calls
      .filter((c) => c.path === '/v3/skill/list')
      .map((c) => (c.body.pagination as { offset: number }).offset);
    expect(listOffsets).toEqual([0, 100]);
  });

  it('stops and returns 500 SKILL_DELETE_FAILED without archiving when 2nd skill delete fails', async () => {
    seedSkills(state, 'agt-1', 3);
    state.skillDeleteOverride = (body) => {
      if (body.skill_id === 'skl-002') {
        return {
          httpStatus: 500,
          code: 500,
          message: 'DB_WRITE_ERROR',
          data: null,
        };
      }
      return undefined;
    };

    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' });

    expect(status).toBe(500);
    expect(json).toMatchObject({
      code: 500,
      message: 'SKILL_DELETE_FAILED',
      data: {
        failed_skill_id: 'skl-002',
        kernel_code: 500,
        kernel_message: 'DB_WRITE_ERROR',
        deleted_skill_ids: ['skl-001'],
      },
    });
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.skills.has('skl-001')).toBe(false);
    expect(state.skills.has('skl-002')).toBe(true);
    expect(state.skills.has('skl-003')).toBe(true);
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('rejects request with missing agent_id (400)', async () => {
    const { status, json } = await callDeleteCascade({});

    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 400, message: 'MISSING_AGENT_ID' });
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('rejects request with invalid user_key (401)', async () => {
    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' }, INVALID_USER_KEY);

    expect(status).toBe(401);
    expect(json).toMatchObject({ code: 401, message: 'INVALID_USER_KEY' });
    // 等待审计中间件对未命中缓存的无效 key 发起的异步 auth/verify 完成，避免关闭 server 时残留连接
    await waitForCondition(
      () =>
        state.calls.filter(
          (c) => c.path === '/v3/meta/auth/verify' && c.body.user_key === INVALID_USER_KEY,
        ).length >= 2,
    );
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('rejects request when agent does not exist (404)', async () => {
    const { status, json } = await callDeleteCascade({ agent_id: 'agt-missing' });

    expect(status).toBe(404);
    expect(json).toMatchObject({ code: 404, message: 'AGENT_NOT_FOUND' });
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('rejects request from non-owner user (403)', async () => {
    const { status, json } = await callDeleteCascade({ agent_id: 'agt-1' }, OTHER_USER_KEY);

    expect(status).toBe(403);
    expect(json).toMatchObject({ code: 403, message: 'NOT_YOUR_AGENT' });
    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });
});
