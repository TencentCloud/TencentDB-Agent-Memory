import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerKnowledgeCallbackRoutes } from '../../src/panel/http/routes/knowledge/callback-routes.js';

function wikiDetail() {
  return {
    wiki_id: 'wiki-1',
    team_id: 'team-1',
    name: 'Wiki 1',
    service_url: 'http://knowledge.test/v3/wiki/wiki-1',
    owner_user_id: 'user-1',
  };
}

function createDeps(overrides: {
  wikiGet?: () => Promise<ReturnType<typeof wikiDetail>>;
  postEnvelope?: () => Promise<{ code: number; message: string; data: unknown }>;
} = {}): PanelDeps {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  return {
    config: { metadataRemoteTimeoutMs: 1_000 },
    logger,
    instanceRegistry: {
      resolve: vi.fn(() => ({
        instance_id: 'instance-1',
        name: 'Instance 1',
        gateway_endpoint: 'http://gateway.test',
        api_key: 'gateway-key',
      })),
    },
    knowledgeClientFactory: vi.fn(() => ({
      wikiGet: overrides.wikiGet ?? vi.fn(async () => wikiDetail()),
    })),
    kernelHttp: {
      postEnvelope: overrides.postEnvelope ?? vi.fn(async () => ({
        code: 0,
        message: 'ok',
        data: {},
      })),
    },
    knowledgeTaskRegistry: {
      peek: vi.fn(),
      take: vi.fn(),
    },
  } as unknown as PanelDeps;
}

async function sendReadyCallback(deps: PanelDeps): Promise<Response> {
  const app = new Hono();
  registerKnowledgeCallbackRoutes(app, deps);
  return app.request('/knowledge/status-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      knowledge_id: 'wiki-1',
      service_id: 'instance-1',
      type: 'wiki',
      status: 'ready',
      summary: 'summary',
    }),
  });
}

describe('knowledge status callback retry semantics', () => {
  it('returns a retryable status when the Knowledge detail fetch fails', async () => {
    const response = await sendReadyCallback(createDeps({
      wikiGet: vi.fn(async () => {
        throw new Error('Knowledge unavailable');
      }),
    }));

    expect(response.status).toBe(502);
  });

  it('returns a retryable status when the kernel rejects detail persistence', async () => {
    const response = await sendReadyCallback(createDeps({
      postEnvelope: vi.fn(async () => ({
        code: 503,
        message: 'kernel unavailable',
        data: null,
      })),
    }));

    expect(response.status).toBe(502);
  });

  it('acknowledges a fully persisted ready callback', async () => {
    const response = await sendReadyCallback(createDeps());

    expect(response.status).toBe(200);
  });
});
