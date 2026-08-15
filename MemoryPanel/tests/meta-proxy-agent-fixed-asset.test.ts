import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

const headers = {
  'content-type': 'application/json',
  'X-Tdai-Service-Id': 'default',
  'X-Tdai-User-Key': 'user-key',
};

function buildApp(invoke: PanelDeps['metaKernel']['invoke']) {
  const app = new Hono();
  const deps = {
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: 'default',
        name: 'Default',
        gateway_endpoint: 'http://memory-core.test',
        api_key: 'gateway-key',
      },
    ]),
    metaKernel: { invoke },
  } as unknown as PanelDeps;
  registerMetaProxyRoutes(app, deps);
  return app;
}

describe('agent-fixed-asset meta proxy policy', () => {
  it('forwards list-with-detail to MemoryCore', async () => {
    const invoke = vi.fn(async () => ({
      code: 0,
      message: 'ok',
      request_id: 'req-1',
      data: { items: [], total: 0, limit: 100, offset: 0 },
    }));
    const app = buildApp(invoke);

    const response = await app.request('/meta/agent-fixed-asset/list-with-detail', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agent_id: 'agent-1',
        apply_visibility_filter: true,
        touch_usage: false,
        limit: 100,
        offset: 0,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: 0,
      data: { items: [], total: 0 },
    });
    expect(invoke).toHaveBeenCalledWith(
      'agent-fixed-asset/list-with-detail',
      {
        agent_id: 'agent-1',
        apply_visibility_filter: true,
        touch_usage: false,
        limit: 100,
        offset: 0,
      },
      expect.objectContaining({
        instanceId: 'default',
        userKey: 'user-key',
      }),
    );
  });

  it.each([
    ['set', { agent_id: 'agent-1', bindings: [] }],
    ['list', { agent_id: 'agent-1' }],
    ['summary-by-agents', { agent_ids: ['agent-1'] }],
  ])('keeps %s outside the public Panel proxy scope', async (action, body) => {
    const invoke = vi.fn();
    const app = buildApp(invoke);

    const response = await app.request(`/meta/agent-fixed-asset/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      code: 501,
      message: 'NOT_IN_SCOPE',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
