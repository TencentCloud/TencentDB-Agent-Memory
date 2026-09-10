import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CaptureService, CaptureServiceError, buildSkillConversationPayload, createCaptureId } from '../src/core/capture-service.js';
import { GatewayClient, GatewayError } from '../src/core/gateway-client.js';
import { Outbox } from '../src/core/outbox.js';

const turn = (overrides = {}) => ({
  version: 1,
  turn_id: 'turn-1',
  session_id: 'session-1',
  prompt: '请读取 README',
  created_at: '2026-08-16T00:00:00.000Z',
  lifecycle_status: 'completed',
  assistant_observation: { available: false, content: null },
  tool_events: [{
    tool_call_id: 'call-1', tool_name: 'readFile',
    tool_call: { role: 'tool_call', tool_name: 'readFile', tool_call_id: 'call-1', content: '{"path":"README.md"}' },
    tool_result: { role: 'tool_result', tool_name: 'readFile', tool_call_id: 'call-1', content: 'contents' },
  }],
  ...overrides,
});

const withStateDir = async (run) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-capture-'));
  try { await run(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
};

const startServer = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
};

const readRequest = async (request) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  return { method: request.method, url: request.url, headers: request.headers, body: JSON.parse(raw) };
};

test('builds the exact observed tool trace payload without an assistant message', () => {
  const payload = buildSkillConversationPayload(turn(), { teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' });
  assert.deepEqual(payload, {
    session_id: 'session-1', team_id: 'team-1', user_id: 'user-1', agent_id: 'agent-1', task_id: 'turn-1',
    messages: [
      { role: 'user', content: '请读取 README', timestamp: '2026-08-16T00:00:00.000Z' },
      { role: 'tool_call', tool_name: 'readFile', tool_call_id: 'call-1', content: '{"path":"README.md"}' },
      { role: 'tool_result', tool_name: 'readFile', tool_call_id: 'call-1', content: 'contents' },
    ],
  });
  assert.throws(() => buildSkillConversationPayload(turn({ lifecycle_status: 'pending' }), {}), CaptureServiceError);
  assert.throws(() => buildSkillConversationPayload(turn({ tool_events: [] }), {}), CaptureServiceError);
});

test('whitelists trace messages and rejects non-finite canonical values', () => {
  const tainted = turn();
  tainted.tool_events[0].tool_call.local_state = 'must-not-leave-disk';
  tainted.tool_events[0].tool_result.credential = 'must-not-leave-disk';
  const payload = buildSkillConversationPayload(tainted, { teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' });
  assert.deepEqual(payload.messages[1], { role: 'tool_call', tool_name: 'readFile', tool_call_id: 'call-1', content: '{"path":"README.md"}' });
  assert.deepEqual(payload.messages[2], { role: 'tool_result', tool_name: 'readFile', tool_call_id: 'call-1', content: 'contents' });
  assert.equal(JSON.stringify(payload).includes('must-not-leave-disk'), false);
  assert.throws(() => createCaptureId({ sessionId: 'session-1', turnId: 'turn-1', payload: { value: NaN } }), CaptureServiceError);
  assert.throws(() => createCaptureId({ sessionId: 'session-1', turnId: 'turn-1', payload: { value: Infinity } }), CaptureServiceError);
});

test('derives stable capture ids and rejects unsafe ids', () => {
  const payload = buildSkillConversationPayload(turn(), { teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' });
  const id = createCaptureId({ adapterVersion: '1', sessionId: 'session-1', turnId: 'turn-1', payload });
  assert.match(id, /^cap_sha256_[a-f0-9]{64}$/);
  assert.equal(createCaptureId({ adapterVersion: '1', sessionId: 'session-1', turnId: 'turn-1', payload }), id);
  assert.notEqual(createCaptureId({ adapterVersion: '2', sessionId: 'session-1', turnId: 'turn-1', payload }), id);
});

test('posts the exact skill conversation request and only accepts safe responses', async () => {
  let received;
  const server = await startServer(async (request, response) => {
    received = await readRequest(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: { status: 'archived', archived: { task_id: 'turn-1', archived_at_ms: 1, archive_key: 'key-1', reason: 'tool_calls' } } }));
  });
  try {
    const client = new GatewayClient({ gatewayUrl: server.url, timeoutMs: 1000, serviceId: 'svc', apiKey: 'key' });
    const payload = buildSkillConversationPayload(turn(), { teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' });
    assert.equal((await client.skillConversationAdd(payload)).status, 'archived');
    assert.equal(received.method, 'POST'); assert.equal(received.url, '/v3/skill/conversation/add');
    assert.equal(received.headers['x-tdai-service-id'], 'svc'); assert.equal(received.headers.authorization, 'Bearer key');
    assert.deepEqual(received.body, payload);
  } finally { await server.close(); }
});

test('rejects malformed skill conversation success data without exposing it', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: { status: 'ok', secret: 'must-not-be-accepted' } }));
  });
  try {
    const client = new GatewayClient({ gatewayUrl: server.url, timeoutMs: 1000, serviceId: 'svc' });
    await assert.rejects(client.skillConversationAdd({}), (error) => error instanceof GatewayError && error.message === 'Gateway response envelope is invalid' && !error.message.includes('must-not-be-accepted'));
  } finally { await server.close(); }
});

test('enforces call-specific gateway timeout and strict archived fields', async () => {
  const delayed = await startServer((request, response) => setTimeout(() => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 0, data: { status: 'ok' } }));
  }, 200));
  try {
    const client = new GatewayClient({ gatewayUrl: delayed.url, timeoutMs: 1000, serviceId: 'svc' });
    const started = Date.now();
    await assert.rejects(client.skillConversationAdd({}, { timeoutMs: 30 }), (error) => error instanceof GatewayError && error.retryable === true);
    assert.equal(Date.now() - started < 150, true);
  } finally { await delayed.close(); }

  const invalidArchived = await startServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: { status: 'archived', archived: { task_id: 'turn-1', archived_at_ms: -1, archive_key: 'key', reason: 'unexpected' } } }));
  });
  try {
    const client = new GatewayClient({ gatewayUrl: invalidArchived.url, timeoutMs: 1000, serviceId: 'svc' });
    await assert.rejects(client.skillConversationAdd({}), GatewayError);
  } finally { await invalidArchived.close(); }
});

test('capture service retains gateway failures but propagates durable persistence failures', async () => {
  await withStateDir(async (stateDir) => {
    const service = new CaptureService({
      config: { stateDir, teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' },
      gatewayClient: { skillConversationAdd: async () => { throw new GatewayError('offline'); } },
      now: () => new Date('2026-08-14T08:00:00.000Z'),
    });
    const pending = await service.captureObservedToolTrace(turn());
    assert.deepEqual(pending, { captureStatus: 'retry_pending', captureId: pending.captureId });
    const persistenceFailure = new CaptureService({
      config: { stateDir, teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' },
      outbox: { hasMarker: async () => false, enqueue: async () => { throw new Error('disk'); } },
    });
    await assert.rejects(persistenceFailure.captureObservedToolTrace(turn()), /disk/);
    await assert.rejects(service.captureFullTurn(turn(), 'nope'), (error) => error instanceof CaptureServiceError && error.message === 'Full turn capture is unsupported');
  });
});

test('capture service flushes a pre-existing marker and outbox without another gateway call', async () => {
  await withStateDir(async (stateDir) => {
    let calls = 0;
    const config = { stateDir, teamId: 'team-1', userId: 'user-1', agentId: 'agent-1' };
    const outbox = new Outbox({ stateDir, gatewayClient: { skillConversationAdd: async () => { calls += 1; return { status: 'ok' }; } } });
    const capturePayload = buildSkillConversationPayload(turn(), config);
    const captureId = createCaptureId({ sessionId: 'session-1', turnId: 'turn-1', payload: capturePayload });
    const item = { capture_id: captureId, type: 'skill_conversation', session_id: 'session-1', turn_id: 'turn-1', payload: capturePayload };
    await outbox.enqueue(item);
    await outbox.writeMarker(item);
    const service = new CaptureService({ config, outbox });
    assert.deepEqual(await service.captureObservedToolTrace(turn()), { captureStatus: 'partial_captured', captureId });
    assert.equal(calls, 0);
    await assert.rejects(readFile(outbox.outboxPath(captureId), 'utf8'), { code: 'ENOENT' });
  });
});
