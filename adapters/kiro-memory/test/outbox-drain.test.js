import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Outbox, OutboxError } from '../src/core/outbox.js';
import { OutboxDrainService } from '../src/core/outbox-drain-service.js';
import { GatewayError } from '../src/core/gateway-client.js';

const operationId = (suffix) => `cap_sha256_${suffix.repeat(64)}`;
const item = (suffix, sessionId, overrides = {}) => ({
  version: 2,
  operation_id: operationId(suffix),
  operation_type: 'skill_conversation',
  session_id: sessionId,
  created_at: `2026-08-14T08:00:0${suffix.charCodeAt(0) % 10}.000Z`,
  next_retry_at: null,
  manual_review: false,
  ...overrides,
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('drain bounds cross-session concurrency and emits only aggregate fields', async () => {
  let active = 0;
  let maximum = 0;
  const candidates = ['a', 'b', 'c', 'd'].map((suffix) => item(suffix, `session-${suffix}`));
  const outbox = {
    listDrainCandidates: async () => candidates,
    withDeliveryLaneUntil: async (_sessionId, _deadline, operation) => operation(),
    processOperation: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(15);
      active -= 1;
      return 'acknowledged';
    },
  };
  const summary = await new OutboxDrainService({ outbox }).drain({ concurrency: 2, budgetMs: 500 });
  assert.equal(maximum, 2);
  assert.deepEqual(summary, {
    selected: 4, processed: 4, acknowledged: 4, failed: 0,
    deferred: 0, manualReview: 0, durationMs: summary.durationMs,
  });
  assert.deepEqual(Object.keys(summary), [
    'selected', 'processed', 'acknowledged', 'failed', 'deferred', 'manualReview', 'durationMs',
  ]);
});

test('drain preserves lane order and stops after a failed head', async () => {
  const calls = [];
  const candidates = ['a', 'b', 'c'].map((suffix) => item(suffix, 'same-session'));
  candidates[1].operation_type = 'force_archive';
  const outcomes = new Map([[operationId('a'), 'acknowledged'], [operationId('b'), 'failed']]);
  const outbox = {
    listDrainCandidates: async () => candidates,
    withDeliveryLaneUntil: async (_sessionId, _deadline, operation) => operation(),
    processOperation: async (id) => { calls.push(id); return outcomes.get(id) ?? 'acknowledged'; },
  };
  const summary = await new OutboxDrainService({ outbox }).drain({ budgetMs: 500 });
  assert.deepEqual(calls, [operationId('a'), operationId('b')]);
  assert.deepEqual(
    { selected: summary.selected, processed: summary.processed, acknowledged: summary.acknowledged, failed: summary.failed },
    { selected: 2, processed: 2, acknowledged: 1, failed: 1 },
  );
});

test('drain stops claiming at the absolute budget and rejects unsafe limits', async () => {
  let clock = 0;
  const calls = [];
  const outbox = {
    listDrainCandidates: async () => [item('a', 'first'), item('b', 'second')],
    withDeliveryLaneUntil: async (_sessionId, _deadline, operation) => operation(),
    processOperation: async (id) => { calls.push(id); clock = 100; return 'acknowledged'; },
  };
  const service = new OutboxDrainService({ outbox, monotonicNow: () => clock });
  const summary = await service.drain({ concurrency: 1, budgetMs: 100 });
  assert.deepEqual(calls, [operationId('a')]);
  assert.equal(summary.selected, 1);
  assert.equal(summary.durationMs, 100);
  await assert.rejects(
    service.drain({ maxItems: 101 }),
    (error) => error instanceof OutboxError && error.message === 'Invalid drain options',
  );
});

test('a fatal lane error stops new claims and drain waits for in-flight work', async () => {
  const calls = [];
  let releaseSecond;
  let secondStarted;
  const started = new Promise((resolve) => { secondStarted = resolve; });
  const release = new Promise((resolve) => { releaseSecond = resolve; });
  const fatal = new OutboxError('Outbox persistence failed');
  const outbox = {
    listDrainCandidates: async () => [item('a', 'first'), item('b', 'second'), item('c', 'third')],
    withDeliveryLaneUntil: async (_sessionId, _deadline, operation) => operation(),
    processOperation: async (id) => {
      calls.push(id);
      if (id === operationId('a')) { await started; throw fatal; }
      if (id === operationId('b')) { secondStarted(); await release; return 'acknowledged'; }
      return 'acknowledged';
    },
  };
  const pending = new OutboxDrainService({ outbox }).drain({ concurrency: 2, budgetMs: 500 });
  await started;
  await delay(10);
  releaseSecond();
  await assert.rejects(pending, (error) => error === fatal);
  assert.deepEqual(calls, [operationId('a'), operationId('b')]);
  await delay(20);
  assert.deepEqual(calls, [operationId('a'), operationId('b')]);
});

test('manual or future lane heads do not block other sessions and Hook does not bypass them', async () => {
  const manual = item('a', 'blocked', { manual_review: true });
  const blockedTail = item('b', 'blocked');
  const future = item('d', 'future-blocked', { next_retry_at: '2099-01-01T00:00:00.000Z' });
  const futureTail = item('e', 'future-blocked');
  const ready = item('c', 'ready');
  const calls = [];
  const outbox = {
    listDrainCandidates: async () => [manual, blockedTail, future, futureTail, ready],
    withDeliveryLaneUntil: async (_sessionId, _deadline, operation) => operation(),
    processOperation: async (id) => { calls.push(id); return 'acknowledged'; },
  };
  const summary = await new OutboxDrainService({ outbox }).drain({ budgetMs: 500 });
  assert.deepEqual(calls, [operationId('c')]);
  assert.equal(summary.manualReview, 1);
  assert.equal(summary.deferred, 2);

  const hook = new Outbox({ stateDir: 'unused', monotonicNow: () => 0 });
  hook.listItems = async () => [manual, blockedTail, future, futureTail, ready];
  hook.withDeliveryLaneUntil = async (_sessionId, _deadline, operation) => operation();
  hook.processOperation = async (id) => { calls.push(id); return 'acknowledged'; };
  const hookResult = await hook.flush({ budgetMs: 500 });
  assert.deepEqual(calls, [operationId('c'), operationId('c')]);
  assert.deepEqual(hookResult, { processed: 1, acknowledged: 1, deferred: 4, failed: 0 });
});

test('two drains and a Hook share the same per-session delivery lane', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-drain-lane-'));
  try {
    let active = 0;
    let maximum = 0;
    const calls = new Map();
    const gatewayClient = { skillConversationAdd: async (payload) => {
      active += 1;
      maximum = Math.max(maximum, active);
      calls.set(payload.task_id, (calls.get(payload.task_id) ?? 0) + 1);
      await delay(20);
      active -= 1;
      return { status: 'ok' };
    } };
    const makeOutbox = () => new Outbox({ stateDir, gatewayClient, lockTimeoutMs: 500, lockRetryMs: 2 });
    const first = makeOutbox();
    const second = makeOutbox();
    const hook = makeOutbox();
    const envelope = (suffix) => ({
      capture_id: operationId(suffix), type: 'skill_conversation', session_id: 'shared-session', turn_id: `turn-${suffix}`,
      payload: {
        session_id: 'shared-session', team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: `turn-${suffix}`,
        messages: [
          { role: 'user', content: suffix },
          { role: 'tool_call', tool_name: 'readFile', tool_call_id: `call-${suffix}`, content: '{}' },
          { role: 'tool_result', tool_name: 'readFile', tool_call_id: `call-${suffix}`, content: 'ok' },
        ],
      },
    });
    await first.enqueue(envelope('a'));
    await first.enqueue(envelope('b'));
    await Promise.all([
      new OutboxDrainService({ outbox: first }).drain({ budgetMs: 1000 }),
      new OutboxDrainService({ outbox: second }).drain({ budgetMs: 1000 }),
      hook.flush({ maxItems: 3, budgetMs: 1000 }),
    ]);
    assert.equal(maximum, 1);
    assert.deepEqual([...calls.values()], [1, 1]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a second drain rechecks manual review after acquiring a stale lane snapshot', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-drain-manual-race-'));
  try {
    let calls = 0;
    const gatewayClient = { skillConversationAdd: async () => {
      calls += 1;
      throw new GatewayError('rejected', { retryable: false });
    } };
    const first = new Outbox({ stateDir, gatewayClient, lockTimeoutMs: 500, lockRetryMs: 2 });
    const second = new Outbox({ stateDir, gatewayClient, lockTimeoutMs: 500, lockRetryMs: 2 });
    await first.enqueue({
      capture_id: operationId('a'), type: 'skill_conversation', session_id: 'shared-session', turn_id: 'turn-a',
      payload: {
        session_id: 'shared-session', team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: 'turn-a',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'tool_call', tool_name: 'readFile', tool_call_id: 'call-a', content: '{}' },
          { role: 'tool_result', tool_name: 'readFile', tool_call_id: 'call-a', content: 'ok' },
        ],
      },
    });
    let snapshots = 0;
    let releaseSnapshots;
    const snapshotsReady = new Promise((resolve) => { releaseSnapshots = resolve; });
    for (const outbox of [first, second]) {
      const listCandidates = outbox.listDrainCandidates.bind(outbox);
      outbox.listDrainCandidates = async (deadline) => {
        const candidates = await listCandidates(deadline);
        snapshots += 1;
        if (snapshots === 2) releaseSnapshots();
        await snapshotsReady;
        return candidates;
      };
    }
    await Promise.all([
      new OutboxDrainService({ outbox: first }).drain({ budgetMs: 1000 }),
      new OutboxDrainService({ outbox: second }).drain({ budgetMs: 1000 }),
    ]);
    assert.equal(calls, 1);
    assert.equal((await first.readItemUnlocked(operationId('a'))).manual_review, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
