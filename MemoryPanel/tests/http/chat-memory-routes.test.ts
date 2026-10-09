import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import { registerChatMemoryRoutes } from '../../src/panel/http/routes/chat-memory.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

const envelope = (data: unknown, code = 0) => ({ code, message: code === 0 ? 'ok' : 'upstream_error', request_id: 'upstream-request', data });
const ownedAgent = { agent_id: 'agent-a', team_id: 'team-a', owner_user_id: 'user-a', name: 'Agent A' };
const sharedAsset = { asset_id: 'memory-peer', team_id: 'team-a', asset_type: 'chat_memory', owner_user_id: 'user-b', visibility: 'team' };
const allocateBody = { block_id: 'memory-peer', agent_id: 'agent-a', team_id: 'team-a' };

function fixture(options: {
  asset?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  bindings?: Array<Record<string, unknown>>;
  listFailure?: boolean;
  getAsset?: (id: string) => Record<string, unknown>;
} = {}) {
  const bindings = options.bindings ?? [];
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
    if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'user-a' } });
    if (action === 'asset/get') return envelope(options.getAsset?.(body.asset_id as string) ?? options.asset ?? sharedAsset);
    if (action === 'agent/get') return envelope(options.agent ?? ownedAgent);
    if (action === 'agent-fixed-asset/list') return options.listFailure ? envelope(null, 503) : envelope({ items: bindings, total: bindings.length });
    if (action === 'agent-fixed-asset/set') return envelope({ updated: true });
    throw new Error(`Unexpected kernel action: ${action}`);
  });
  const postEnvelope = vi.fn().mockResolvedValue(envelope({ cleared: true }));
  const deps = {
    instanceRegistry: new InstanceRegistry([{ instance_id: 'instance-a', name: 'A', gateway_endpoint: 'https://core.test', api_key: 'server-key' }]),
    metaKernel: { invoke }, kernelHttp: { postEnvelope },
  } as unknown as PanelDeps;
  const app = new Hono();
  registerChatMemoryRoutes(app, deps);
  const request = (path: string, body: unknown) => app.request(`/chat-memory/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': 'instance-a', 'x-tdai-user-key': 'caller-key' }, body: JSON.stringify(body),
  });
  return { invoke, postEnvelope, request };
}

describe('chat-memory allocation business and ownership boundaries', () => {
  it.each([
    { options: { asset: { ...sharedAsset, asset_type: 'skill' } }, code: 400, message: 'NOT_CHAT_MEMORY' },
    { options: { asset: { ...sharedAsset, team_id: 'team-b' } }, code: 400, message: 'TEAM_MISMATCH' },
    { options: { agent: { ...ownedAgent, team_id: 'team-b' } }, code: 400, message: 'AGENT_NOT_IN_TEAM' },
    { options: { agent: { ...ownedAgent, owner_user_id: 'user-b' } }, code: 403, message: 'NOT_YOUR_AGENT' },
    { options: { asset: { ...sharedAsset, visibility: 'private' } }, code: 403, message: 'ASSET_NOT_SHARED' },
  ])('rejects $message before rewriting bindings', async ({ options, code, message }) => {
    const { request, invoke } = fixture(options);
    const response = await request('allocate', allocateBody);
    expect(response.status).toBe(code);
    expect(await response.json()).toMatchObject({ code, message });
    expect(invoke.mock.calls.some(([action]) => action === 'agent-fixed-asset/set')).toBe(false);
  });

  it('does not allocate an agent its own auto-created memory', async () => {
    const { request, invoke } = fixture();
    const response = await request('allocate', { ...allocateBody, block_id: 'chat_memory-team-a-agent-a' });
    expect(response.status).toBe(400);
    expect(invoke.mock.calls.some(([action]) => action === 'agent-fixed-asset/set')).toBe(false);
  });

  it('preserves unrelated assets and excludes self memory from the two-import limit', async () => {
    const bindings = [
      { asset_id: 'chat_memory-team-a-agent-a', asset_type: 'chat_memory', injection_mode: 'full', priority: 5, created_by: 'user-a' },
      { asset_id: 'skill-a', asset_type: 'skill', injection_mode: 'full', priority: 10, created_by: 'user-a' },
      { asset_id: 'other-memory', asset_type: 'chat_memory', injection_mode: 'summary', priority: 50, created_by: 'user-a' },
    ];
    const { request, invoke } = fixture({ bindings });
    const response = await request('allocate', allocateBody);
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith('agent-fixed-asset/set', {
      agent_id: 'agent-a', bindings: [...bindings, { asset_id: 'memory-peer', asset_type: 'chat_memory', injection_mode: 'summary', priority: 50, created_by: 'user-a' }],
    }, expect.objectContaining({ instanceId: 'instance-a', userKey: 'caller-key' }));
  });

  it('rejects a third imported memory without altering bindings', async () => {
    const bindings = ['memory-1', 'memory-2'].map((asset_id) => ({ asset_id, asset_type: 'chat_memory' }));
    const { request, invoke } = fixture({ bindings });
    const response = await request('allocate', allocateBody);
    expect(await response.json()).toMatchObject({ code: 400, message: 'IMPORT_LIMIT_EXCEEDED' });
    expect(invoke.mock.calls.some(([action]) => action === 'agent-fixed-asset/set')).toBe(false);
  });

  it('does not overwrite bindings when their upstream listing fails', async () => {
    const { request, invoke } = fixture({ listFailure: true });
    const response = await request('allocate', allocateBody);
    expect(response.status).toBe(503);
    expect(invoke.mock.calls.some(([action]) => action === 'agent-fixed-asset/set')).toBe(false);
  });
});

describe('chat-memory batch clear boundary', () => {
  it('preflights the entire batch before issuing a destructive data-plane call', async () => {
    const { request, postEnvelope } = fixture({ getAsset: (id) => ({ ...sharedAsset, asset_id: id, owner_user_id: id === 'mine' ? 'user-a' : 'user-b' }) });
    const response = await request('clear', { memory_ids: ['mine', 'someone-elses'] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'NOT_ASSET_OWNER' });
    expect(postEnvelope).not.toHaveBeenCalled();
  });

  it('deduplicates valid IDs and forwards the caller to the authoritative Kernel check', async () => {
    const { request, postEnvelope } = fixture({ asset: { ...sharedAsset, owner_user_id: 'user-a' } });
    const response = await request('clear', { memory_ids: [' memory-a ', '', 'memory-a', 'memory-b'] });
    expect(response.status).toBe(200);
    expect(postEnvelope).toHaveBeenCalledWith('/v3/chat-memory/clear', { memory_ids: ['memory-a', 'memory-b'] }, expect.objectContaining({ instanceId: 'instance-a', userKey: 'caller-key', timeoutMs: 60_000 }));
  });

  it('rejects more than 100 unique IDs before resolving or changing any asset', async () => {
    const { request, invoke, postEnvelope } = fixture();
    const response = await request('clear', { memory_ids: Array.from({ length: 101 }, (_, n) => `memory-${n}`) });
    expect(await response.json()).toMatchObject({ code: 400, message: 'TOO_MANY_MEMORY_IDS' });
    expect(invoke).not.toHaveBeenCalled();
    expect(postEnvelope).not.toHaveBeenCalled();
  });
});
