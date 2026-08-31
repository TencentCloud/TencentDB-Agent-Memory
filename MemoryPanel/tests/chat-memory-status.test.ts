import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerChatMemoryStatusRoutes } from '../src/panel/http/routes/chat-memory-status.js';

function createApp(opts: { manual?: boolean; failedPath?: string } = {}) {
  const blockId = opts.manual ? 'mem-manual' : 'chat_memory-team-1-agt-1';
  const metaInvoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') return { code: 0, message: 'ok', request_id: 'r', data: { valid: true, user: { user_id: 'user-1' } } };
    if (action === 'asset/get') return { code: 0, message: 'ok', request_id: 'r', data: { asset_id: blockId, asset_type: 'chat_memory', team_id: 'team-1', owner_user_id: 'user-1', visibility: 'private', name: 'Memory', status: 'active', updated_at: '' } };
    throw new Error(`unexpected ${action}`);
  });
  const postEnvelope = vi.fn(async (path: string) => {
    if (path === opts.failedPath) throw new Error('unavailable');
    if (path === '/v3/conversation/count') return { code: 0, data: { total: 4 } };
    if (path === '/v3/atomic/count') return { code: 0, data: { total: 3 } };
    if (path === '/v3/scenario/count') return { code: 0, data: { total: 2 } };
    if (path === '/v3/core/count') return { code: 0, data: { total: 1 } };
    throw new Error(`unexpected ${path}`);
  });
  const deps = {
    instanceRegistry: { resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'secret' }) },
    config: { metadataRemoteTimeoutMs: 15_000 },
    metaKernel: { invoke: metaInvoke },
    kernelHttp: { postEnvelope },
  } as never;
  const app = new Hono();
  registerChatMemoryStatusRoutes(app, deps);
  return { app, blockId, postEnvelope };
}

async function callStatus(app: Hono, blockId: string) {
  return app.request('/chat-memory/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Tdai-Service-Id': 'local', 'X-Tdai-User-Key': 'user-key' },
    body: JSON.stringify({ block_id: blockId }),
  });
}

describe('chat-memory/status', () => {
  it('returns counts without memory content', async () => {
    const { app, blockId, postEnvelope } = createApp();
    const response = await callStatus(app, blockId);
    const envelope = await response.json() as { data: Record<string, unknown> };
    expect(response.status).toBe(200);
    expect(envelope.data.layer_counts).toEqual({ L0_messages: 4, L1: 3, L2: 2, L3: 1 });
    expect(postEnvelope.mock.calls.map(([path]) => path)).toEqual([
      '/v3/conversation/count',
      '/v3/atomic/count',
      '/v3/scenario/count',
      '/v3/core/count',
    ]);
  });

  it('marks a failed layer as partial instead of zero', async () => {
    const { app, blockId } = createApp({ failedPath: '/v3/atomic/count' });
    const envelope = await (await callStatus(app, blockId)).json() as { data: { availability: string; layer_counts: Record<string, number | null>; unavailable_layers: string[] } };
    expect(envelope.data.availability).toBe('partial');
    expect(envelope.data.layer_counts.L1).toBeNull();
    expect(envelope.data.unavailable_layers).toEqual(['L1']);
  });

  it('does not query layers for a manual memory block', async () => {
    const { app, blockId, postEnvelope } = createApp({ manual: true });
    const envelope = await (await callStatus(app, blockId)).json() as { data: { availability: string } };
    expect(envelope.data.availability).toBe('not_applicable');
    expect(postEnvelope).not.toHaveBeenCalled();
  });
});
