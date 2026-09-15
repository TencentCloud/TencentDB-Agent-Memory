import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';

const TEAM_ID = 'team-t9ihoml202';
const AGENT_ID = 'openclaw';
const OWNER_ID = 'usr-t9oh1rmkpc';
const ASSET_ID = `chat_memory-${TEAM_ID}-${AGENT_ID}`;

function ok<T>(data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: 'test', data };
}

function buildApp() {
  const calls: Array<{ path: string; body: unknown }> = [];
  const deps = {
    instanceRegistry: {
      resolve: () => ({
        instance_id: 'default',
        gateway_endpoint: 'http://kernel.test',
        api_key: 'test-key',
      }),
    },
    metaKernel: {
      invoke: async (action: string) => {
        if (action === 'auth/verify') return ok({ valid: true, user: { user_id: OWNER_ID } });
        if (action === 'asset/get') {
          return ok({
            asset_id: ASSET_ID,
            team_id: TEAM_ID,
            asset_type: 'chat_memory',
            name: 'Memory of OpenClaw',
            owner_user_id: OWNER_ID,
            visibility: 'team',
            status: 'active',
            updated_at: '2026-08-30T00:00:00.000Z',
          });
        }
        if (action === 'asset/list') {
          return ok({
            items: [{
              asset_id: ASSET_ID,
              team_id: TEAM_ID,
              asset_type: 'chat_memory',
              name: 'Memory of OpenClaw',
              owner_user_id: OWNER_ID,
              visibility: 'team',
              status: 'active',
              updated_at: '2026-08-30T00:00:00.000Z',
            }],
            total: 1,
          });
        }
        throw new Error(`Unexpected meta action: ${action}`);
      },
    },
    kernelHttp: {
      postEnvelope: async (path: string, body: unknown) => {
        calls.push({ path, body });
        if (path === '/v2/conversation/query') {
          return ok({ messages: [{ id: 'l0-1', role: 'user', content: 'record' }], total: 7218 });
        }
        if (path === '/v2/atomic/query') {
          return ok({ items: [{ record_id: 'l1-1', type: 'episodic', content: 'memory' }], total: 589 });
        }
        if (path === '/v3/scenario/ls') return ok({ entries: [{ path: 'OpenClaw.md' }], total: 1 });
        if (path === '/v3/core/read') return ok({ content: 'OpenClaw core memory' });
        throw new Error(`Unexpected kernel path: ${path}`);
      },
    },
  } as unknown as PanelDeps;

  const app = new Hono();
  registerChatMemoryRoutes(app, deps);
  return { app, calls };
}

function request(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'default',
      'x-tdai-user-key': 'test-user-key',
    },
    body: JSON.stringify(body),
  });
}

describe('Chat Memory count regression', () => {
  it('does not publish fabricated zero layer counts in team asset lists', async () => {
    const { app } = buildApp();

    const response = await request(app, '/chat-memory/team-assets', { team_id: TEAM_ID });
    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0]).not.toHaveProperty('layer_counts');
    expect(payload.data.items[0]).not.toHaveProperty('summary');
  });

  it.each([
    ['L0', '/v2/conversation/query', 7218],
    ['L1', '/v2/atomic/query', 589],
    ['L2', '/v3/scenario/ls', 1],
    ['L3', '/v3/core/read', 1],
  ] as const)('queries %s by team and agent without the asset-owner user filter', async (layer, endpoint, total) => {
    const { app, calls } = buildApp();

    const response = await request(app, '/chat-memory/layer', {
      block_id: ASSET_ID,
      layer,
      limit: 1,
      offset: 0,
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { total: number } };
    expect(payload.data.total).toBe(total);

    const call = calls.find((entry) => entry.path === endpoint);
    expect(call).toBeDefined();
    expect(call?.body).toMatchObject({ team_id: TEAM_ID, agent_id: AGENT_ID });
    expect(call?.body).not.toHaveProperty('user_id');
    expect(call?.body).not.toHaveProperty('session_id');
  });
});