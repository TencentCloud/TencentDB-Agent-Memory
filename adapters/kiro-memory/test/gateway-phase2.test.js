import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayClient, GatewayError } from '../src/core/gateway-client.js';

const config = {
  gatewayUrl: 'https://memory.example.test', serviceId: 'svc', teamId: 'team',
  agentId: 'agent', userId: 'user', timeoutMs: 2500,
};
const response = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });

test('conversation search is cross-session and preserves validated server message order', async () => {
  let request;
  const client = new GatewayClient(config, { fetch: async (_url, options) => { request = JSON.parse(options.body); return response({ messages: [
    { id: 'm2', role: 'assistant', content: 'second', timestamp: '2026-08-16T00:00:01.000Z', score: 0.7 },
    { id: 'm1', role: 'user', content: 'first', timestamp: '2026-08-16T00:00:00.000Z', score: 0.6 },
  ] }); } });
  const data = await client.conversationSearch('query', 4, { timeStart: '2026-08-01T00:00:00.000Z' });
  assert.equal(Object.hasOwn(request, 'session_id'), false);
  assert.deepEqual(request, {
    team_id: 'team', agent_id: 'agent', user_id: 'user', query: 'query', limit: 4,
    time_start: '2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(data.messages.map((item) => item.id), ['m2', 'm1']);
});

test('skill search sends top_k and exposes only allowlisted normalized fields', async () => {
  let request;
  const client = new GatewayClient(config, { fetch: async (_url, options) => { request = JSON.parse(options.body); return response({ items: [{
    skill_id: 'skill-1', name: 'Deploy', description: 'Deploy safely', snippet: 'safe snippet', score: 8,
    version: 3, status: 'active', updated_at_ms: 1786838400000, owner_user_id: 'must-not-leak', metadata: { private: true },
  }] }); } });
  const data = await client.skillSearch('deploy', 3);
  assert.deepEqual(request, { team_id: 'team', agent_id: 'agent', user_id: 'user', query: 'deploy', top_k: 3, mode: 'hybrid' });
  assert.deepEqual(data.items, [{
    id: 'skill-1', content: 'safe snippet', name: 'Deploy', description: 'Deploy safely',
    version: 3, status: 'active', timestamp: '2026-08-16T00:00:00.000Z',
  }]);
});

test('phase 2 searches reject malformed messages and skill hits safely', async () => {
  for (const [method, data] of [
    ['conversationSearch', { messages: [{ role: 'tool', content: 'bad', score: 1 }] }],
    ['skillSearch', { items: [{ skill_id: 'x', name: 'x', description: 'x', snippet: 4 }] }],
  ]) {
    const client = new GatewayClient(config, { fetch: async () => response(data) });
    await assert.rejects(client[method]('q', 2), (error) => error instanceof GatewayError && !error.retryable);
  }
});

test('an upstream signal aborts an in-flight gateway search safely', async () => {
  let fetchSignal;
  const client = new GatewayClient(config, {
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = client.atomicSearch('query', 1, { timeoutMs: 2500, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof GatewayError && error.message === 'Gateway request failed' && error.retryable === true,
  );
  assert.equal(fetchSignal.aborted, true);
});

test('an upstream signal aborts in-flight Gateway writes as a retryable failure', async () => {
  for (const [method, payload] of [
    ['skillConversationAdd', { session_id: 'session' }],
    ['forceArchive', { sessionId: 'session' }],
  ]) {
    let fetchSignal;
    const client = new GatewayClient(config, {
      fetch: async (_url, options) => {
        fetchSignal = options.signal;
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = client[method](payload, { timeoutMs: 2500, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof GatewayError && error.retryable === true);
    assert.equal(fetchSignal.aborted, true);
  }
});

test('health accepts the real MemoryProxy ok/degraded contract without sending identity headers', async () => {
  for (const [status, body, expected] of [
    [200, { status: 'ok', version: '0.2.0', storage: { enabled: true, requested: 'cos', effective: 'cos', degraded: false } }, 'ok'],
    [503, { status: 'degraded', version: '0.2.0', storage: { enabled: true, requested: 'cos', effective: 'memory', degraded: true } }, 'degraded'],
  ]) {
    let requestOptions;
    const client = new GatewayClient({ ...config, apiKey: 'must-not-send' }, { fetch: async (_url, options) => {
      requestOptions = options;
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    } });
    assert.deepEqual(await client.health(), { status: expected });
    assert.equal(Object.hasOwn(requestOptions, 'headers'), false);
  }
});

test('health rejects oversized or contradictory bodies without exposing them', async () => {
  const oversized = JSON.stringify({ status: 'ok', version: '0.2.0', storage: { degraded: false }, padding: 'x'.repeat(20_000) });
  for (const [status, source] of [
    [200, oversized],
    [503, JSON.stringify({ status: 'ok', version: '0.2.0', storage: { degraded: false } })],
  ]) {
    const client = new GatewayClient(config, { fetch: async () => ({ ok: status === 200, status, text: async () => source }) });
    await assert.rejects(client.health(), (error) => error instanceof GatewayError && !error.message.includes('padding'));
  }
});
