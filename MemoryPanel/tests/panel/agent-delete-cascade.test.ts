import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { buildPanelApp } from '../../src/panel/http/app.js';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { PanelConfig } from '../../src/panel/config/panel-config.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from '../../src/panel/kernel/adapters/fetch-skill-kernel-adapter.js';
import { FetchAnalyticsKernelAdapter } from '../../src/panel/kernel/adapters/fetch-analytics-kernel-adapter.js';
import { FetchTaskSourceAdapter } from '../../src/panel/kernel/adapters/fetch-task-source-adapter.js';
import { KnowledgeTaskRegistry } from '../../src/panel/state/knowledge-task-registry.js';
import { IngestProgressStore } from '../../src/panel/state/ingest-progress-store.js';
import { createPanelApiCallTelemetry } from '../../src/panel/infra/api-call-telemetry.js';
import { PanelAuthService } from '../../src/panel/auth/service.js';
import { PanelUserIdResolver } from '../../src/panel/infra/user-id-resolver.js';
import type { Logger } from '../../src/panel/infra/logger.js';
import type { KnowledgeClientPort } from '../../src/panel/kernel/ports/knowledge-client-port.js';
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

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
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
  const status = payload.httpStatus ?? (payload.code >= 400 && payload.code < 600 ? payload.code : 200);
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
      const userKey = typeof body.user_key === 'string' ? body.user_key : '';
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
      if (body.expected_version !== skill.version) {
        sendEnvelope(res, requestId, { code: 409, message: 'VERSION_CONFLICT', data: null });
        return;
      }
      skill.status = 'archived';
      sendEnvelope(res, requestId, {
        code: 0,
        message: 'ok',
        data: { skill_id: skill.skill_id, status: 'archived' },
      });
      return;
    }

    sendEnvelope(res, requestId, { code: 404, message: `UNHANDLED_PATH:${path}`, data: null });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

function buildTestPanelConfig(): PanelConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    metadataInstancesConfig: '',
    metadataRemoteTimeoutMs: 5_000,
    ui: { distDir: tmpdir() },
    log: { level: 'error', format: 'json' },
    knowledge: { baseUrl: 'http://127.0.0.1:1', authToken: '', timeoutMs: 1_000 },
    knowledgeLlmBinding: { sync: false, proxyBaseUrl: 'http://127.0.0.1:1' },
    agentTemplateDir: '/tmp/panel-test-templates',
    featureAnalyticsEnabled: false,
    clickhouse: {
      enabled: false,
      url: '',
      database: 'default',
      table: 'panel_api_call_logs',
      user: 'default',
      password: '',
      flushIntervalMs: 5_000,
      flushThreshold: 50,
      ttlDays: 90,
      requestTimeoutMs: 1_000,
    },
    wiki: {
      textFileMaxBytes: 512 * 1024,
      binaryFileMaxBytes: 10 * 1024 * 1024,
    },
    auth: {
      userKeyEnabled: true,
      idpEnabled: false,
      sessionTtlSeconds: 3_600,
      sessionCookieName: 'tdai_idp_session',
      sessionSecure: false,
      sessionSecret: '',
      identityStorePath: '/tmp/panel-test-identities.json',
      woa: {
        enabled: false,
        appToken: '',
        safeMode: true,
        requireSignature: true,
        appUrl: '',
        loginUrl: '',
        logoutUrl: '',
        paasId: '',
        defaultTeamId: '',
        defaultRole: 'member',
        authProvider: 'local',
      },
      taskSource: {
        enabled: [],
        tapd: { mcpUrl: '', siteBaseUrl: '' },
      },
    },
  };
}

function buildTestPanelDeps(gatewayEndpoint: string): PanelDeps {
  const config = buildTestPanelConfig();
  const logger = createSilentLogger();
  const instanceRegistry = new InstanceRegistry([
    {
      instance_id: INSTANCE_ID,
      name: 'Test Instance',
      gateway_endpoint: gatewayEndpoint,
      api_key: GATEWAY_API_KEY,
    },
  ]);
  const kernelHttp = new FetchKernelHttpAdapter(logger);
  const metaKernel = new FetchMetaKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const skillKernel = new FetchSkillKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const analyticsKernel = new FetchAnalyticsKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const taskSourceKernel = new FetchTaskSourceAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const userIdResolver = new PanelUserIdResolver(metaKernel, logger);
  // 预热有效测试 key，避免 telemetry 中间件在响应后异步补发 auth/verify 干扰调用顺序断言
  userIdResolver.warm(OWNER_USER_KEY, 'usr-owner', INSTANCE_ID);
  userIdResolver.warm(OTHER_USER_KEY, 'usr-other', INSTANCE_ID);
  const apiCallTelemetry = createPanelApiCallTelemetry(config.clickhouse, logger, () => null);
  const auth = new PanelAuthService({
    config: config.auth,
    instances: instanceRegistry,
    metaKernel,
    logger,
  });

  return {
    config,
    logger,
    instanceRegistry,
    kernelHttp,
    metaKernel,
    knowledgeClientFactory: () => ({}) as KnowledgeClientPort,
    skillKernel,
    analyticsKernel,
    taskSourceKernel,
    knowledgeTaskRegistry: new KnowledgeTaskRegistry(),
    ingestProgressStore: new IngestProgressStore(),
    apiCallTelemetry,
    auth,
    userIdResolver,
  };
}

async function startPanelServer(gatewayEndpoint: string): Promise<{
  server: ServerType;
  baseUrl: string;
}> {
  const app = buildPanelApp(buildTestPanelDeps(gatewayEndpoint));
  const server = await new Promise<ServerType>((resolve) => {
    const srv = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(srv));
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: http.Server | ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('POST /api/v1/agent/delete-cascade (E2E)', () => {
  let state: MockGatewayState;
  let gatewayServer: http.Server;
  let panelServer: ServerType;
  let panelBaseUrl: string;

  async function callDeleteCascade(
    body: Record<string, unknown>,
    userKey = OWNER_USER_KEY,
  ): Promise<{ status: number; json: { code: number; message: string; request_id: string; data: unknown } }> {
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
    state = createMockGatewayState();
    const gw = await startMockKernelGateway(state);
    gatewayServer = gw.server;
    const panel = await startPanelServer(gw.endpoint);
    panelServer = panel.server;
    panelBaseUrl = panel.baseUrl;
  });

  afterEach(async () => {
    await closeServer(panelServer);
    await closeServer(gatewayServer);
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

  it('fails closed when /v3/skill/list returns a different 404 message', async () => {
    for (const msg of ['Not Found', 'skill module not enabled']) {
      state.calls.length = 0;
      state.agents.get('agt-1')!.status = 'active';
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
    }
  });

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
    expect([...state.skills.values()].every((s) => s.status === 'active')).toBe(true);
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
    expect([...state.skills.values()].every((s) => s.status === 'archived')).toBe(true);

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
    expect(state.skills.get('skl-001')?.status).toBe('archived');
    expect(state.skills.get('skl-002')?.status).toBe('active');
    expect(state.skills.get('skl-003')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });

  it('enforces guards: missing agent_id (400), invalid user_key (401), missing agent (404), non-owner (403)', async () => {
    const missingId = await callDeleteCascade({});
    expect(missingId.status).toBe(400);
    expect(missingId.json).toMatchObject({ code: 400, message: 'MISSING_AGENT_ID' });

    const invalidKey = await callDeleteCascade({ agent_id: 'agt-1' }, INVALID_USER_KEY);
    expect(invalidKey.status).toBe(401);
    expect(invalidKey.json).toMatchObject({ code: 401, message: 'INVALID_USER_KEY' });

    const notFound = await callDeleteCascade({ agent_id: 'agt-missing' });
    expect(notFound.status).toBe(404);
    expect(notFound.json).toMatchObject({ code: 404, message: 'AGENT_NOT_FOUND' });

    const nonOwner = await callDeleteCascade({ agent_id: 'agt-1' }, OTHER_USER_KEY);
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.json).toMatchObject({ code: 403, message: 'NOT_YOUR_AGENT' });

    expect(state.agents.get('agt-1')?.status).toBe('active');
    expect(state.calls.some((c) => c.path === '/v3/meta/agent/archive')).toBe(false);
  });
});
