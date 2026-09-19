import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Outbox, OutboxError, isValidOutboxMarker } from '../src/core/outbox.js';

const id = (suffix = 'a') => `cap_sha256_${suffix.repeat(64)}`;
const payload = (suffix = 'a') => ({ session_id: `session-${suffix}`, team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: `turn-${suffix}`, messages: [
  { role: 'user', content: suffix },
  { role: 'tool_call', tool_name: 'readFile', tool_call_id: `call-${suffix}`, content: '{}' },
  { role: 'tool_result', tool_name: 'readFile', tool_call_id: `call-${suffix}`, content: 'ok' },
] });
const envelope = (suffix = 'a') => ({ capture_id: id(suffix), type: 'skill_conversation', session_id: `session-${suffix}`, turn_id: `turn-${suffix}`, payload: payload(suffix) });
const withStateDir = async (run) => { const stateDir = await mkdtemp(join(tmpdir(), 'kiro-outbox-')); try { await run(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); } };

test('writeMarker persists a canonical v2 operation marker', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-outbox-marker-v2-'));
  try {
    const outbox = new Outbox({ stateDir });
    const input = envelope('c');
    await outbox.writeMarker(input);

    const marker = JSON.parse(await readFile(outbox.markerPath(input.capture_id), 'utf8'));
    assert.equal(marker.version, 2);
    assert.equal(marker.operation_id, input.capture_id);
    assert.equal(marker.operation_type, 'skill_conversation');
    assert.equal(marker.session_id, input.session_id);
    assert.equal(marker.turn_id, input.turn_id);
    assert.deepEqual(marker.result, { status: 'ok' });
    assert.equal(Object.hasOwn(marker, 'capture_id'), false);
    assert.equal(isValidOutboxMarker(marker, input.capture_id), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('enqueues idempotently, preserves retry state, validates ids, and serializes concurrent calls', async () => {
  await withStateDir(async (stateDir) => {
    const now = () => new Date('2026-08-14T08:00:00.000Z');
    const outbox = new Outbox({ stateDir, now });
    const first = await outbox.enqueue(envelope());
    const updated = { ...first, attempt_count: 2, next_retry_at: '2026-08-14T08:00:02.000Z' };
    await writeFile(outbox.outboxPath(id()), `${JSON.stringify(updated)}\n`, 'utf8');
    assert.deepEqual(await outbox.enqueue(envelope()), updated);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => outbox.enqueue(envelope('b'))));
    assert.equal(new Set(concurrent.map((item) => JSON.stringify(item))).size, 1);
    assert.throws(() => outbox.outboxPath('../unsafe'), OutboxError);
  });
});

test('keeps failed work with fixed backoff, skips future work, and acknowledges recovered work', async () => {
  await withStateDir(async (stateDir) => {
    let time = new Date('2026-08-14T08:00:00.000Z'); const now = () => time;
    let online = false; let calls = 0;
    const outbox = new Outbox({ stateDir, now, gatewayClient: { skillConversationAdd: async () => { calls += 1; if (!online) throw new Error('offline'); return { status: 'ok' }; } } });
    await outbox.enqueue(envelope());
    assert.deepEqual(await outbox.flush(), { processed: 1, acknowledged: 0, deferred: 0, failed: 1 });
    const retry = JSON.parse(await readFile(outbox.outboxPath(id()), 'utf8'));
    assert.equal(retry.attempt_count, 1); assert.equal(retry.next_retry_at, '2026-08-14T08:00:01.000Z');
    assert.deepEqual(await outbox.flush(), { processed: 0, acknowledged: 0, deferred: 1, failed: 0 }); assert.equal(calls, 1);
    time = new Date('2026-08-14T08:00:01.000Z'); online = true;
    assert.deepEqual(await outbox.flush(), { processed: 1, acknowledged: 1, deferred: 0, failed: 0 });
    await assert.rejects(readFile(outbox.outboxPath(id()), 'utf8'), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(outbox.markerPath(id()), 'utf8')).operation_id, id());
  });
});

test('uses the complete fixed retry sequence and survives a new outbox instance', async () => {
  await withStateDir(async (stateDir) => {
    let time = new Date('2026-08-14T08:00:00.000Z'); const now = () => time;
    const offline = { skillConversationAdd: async () => { throw new Error('offline'); } };
    const first = new Outbox({ stateDir, now, gatewayClient: offline });
    await first.enqueue(envelope());
    const delays = [1, 2, 5, 10, 30, 30];
    for (let index = 0; index < delays.length; index += 1) {
      await first.flush();
      const item = JSON.parse(await readFile(first.outboxPath(id()), 'utf8'));
      assert.equal(item.attempt_count, index + 1);
      assert.equal(item.next_retry_at, new Date(time.getTime() + delays[index] * 1000).toISOString());
      time = new Date(item.next_retry_at);
    }
    let recoveredCalls = 0;
    const restarted = new Outbox({ stateDir, now, gatewayClient: { skillConversationAdd: async () => { recoveredCalls += 1; return { status: 'ok' }; } } });
    assert.equal((await restarted.flush()).acknowledged, 1);
    assert.equal(recoveredCalls, 1);
  });
});

test('does not resend when a marker and outbox coexist, isolates corrupt files, and limits stable flushes', async () => {
  await withStateDir(async (stateDir) => {
    let calls = 0; const outbox = new Outbox({ stateDir, now: () => new Date('2026-08-14T08:00:00.000Z'), gatewayClient: { skillConversationAdd: async () => { calls += 1; return { status: 'ok' }; } } });
    for (const suffix of ['d', 'c', 'b', 'a']) await outbox.enqueue(envelope(suffix));
    await writeFile(join(stateDir, 'outbox', 'not-a-capture.json'), '{bad', 'utf8');
    await outbox.writeMarker(envelope('a'));
    const result = await outbox.flush({ maxItems: 3 });
    assert.equal(result.processed, 3); assert.equal(result.acknowledged, 3); assert.equal(calls, 2);
    await assert.rejects(readFile(outbox.outboxPath(id('a')), 'utf8'), { code: 'ENOENT' });
  });
});

test('does not send disk-tampered payloads and propagates local retry persistence failures', async () => {
  await withStateDir(async (stateDir) => {
    let calls = 0;
    const outbox = new Outbox({ stateDir, gatewayClient: { skillConversationAdd: async () => { calls += 1; throw new Error('offline'); } } });
    await outbox.enqueue(envelope());
    const tampered = JSON.parse(await readFile(outbox.outboxPath(id()), 'utf8'));
    tampered.payload.messages[0].local_state = 'not-sendable';
    await writeFile(outbox.outboxPath(id()), `${JSON.stringify(tampered)}\n`, 'utf8');
    await outbox.flush();
    assert.equal(calls, 0);

    await outbox.enqueue(envelope('b'));
    outbox.writeItem = async () => { throw new Error('disk-write'); };
    await assert.rejects(outbox.flush(), (error) => error instanceof OutboxError && error.message === 'Outbox persistence failed');
  });
});

test('returns at the flush deadline for an uncooperative gateway without acknowledging later', async () => {
  await withStateDir(async (stateDir) => {
    let resolveGateway;
    let gatewaySignal;
    const outbox = new Outbox({ stateDir, gatewayClient: { skillConversationAdd: async (_payload, options) => {
      gatewaySignal = options.signal;
      return new Promise((resolve) => { resolveGateway = resolve; });
    } } });
    await outbox.enqueue(envelope());
    const started = Date.now();
    const result = await outbox.flush({ budgetMs: 30 });
    assert.equal(Date.now() - started < 180, true);
    assert.equal(result.acknowledged, 0);
    assert.equal(gatewaySignal.aborted, true);
    assert.equal(await outbox.hasMarker(id()), false);
    const deferred = JSON.parse(await readFile(outbox.outboxPath(id()), 'utf8'));
    assert.equal(deferred.attempt_count, 0);
    assert.equal(deferred.next_retry_at, null);
    resolveGateway({ status: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await outbox.hasMarker(id()), false);
    const unchanged = JSON.parse(await readFile(outbox.outboxPath(id()), 'utf8'));
    assert.equal(unchanged.attempt_count, 0);
    assert.equal(unchanged.next_retry_at, null);
  });
});

test('propagates lock and marker persistence errors even when they advance the clock to deadline', async () => {
  await withStateDir(async (stateDir) => {
    let clock = 0;
    const outbox = new Outbox({ stateDir, monotonicNow: () => clock, gatewayClient: { skillConversationAdd: async () => ({ status: 'ok' }) } });
    await outbox.enqueue(envelope());
    outbox.withLockUntil = async () => { clock = 10; throw new OutboxError('Outbox persistence failed'); };
    await assert.rejects(outbox.flush({ budgetMs: 10 }), (error) => error instanceof OutboxError && error.message === 'Outbox persistence failed');

    clock = 0;
    outbox.withLockUntil = Outbox.prototype.withLockUntil;
    outbox.writeMarkerUnlocked = async () => { clock = 10; throw new Error('marker-write'); };
    await assert.rejects(outbox.flush({ budgetMs: 10 }), (error) => error instanceof OutboxError && error.message === 'Outbox persistence failed');
  });
});

test('acknowledgement reconciliation is retried from marker plus outbox without resending Gateway data', async () => {
  await withStateDir(async (stateDir) => {
    let gatewayCalls = 0;
    let reconciliationCalls = 0;
    let failReconciliation = true;
    const outbox = new Outbox({
      stateDir,
      gatewayClient: { skillConversationAdd: async () => { gatewayCalls += 1; return { status: 'ok' }; } },
      onAcknowledged: async (item, result) => {
        reconciliationCalls += 1;
        assert.equal(item.operation_id, id());
        assert.deepEqual(result, { status: 'ok' });
        if (failReconciliation) throw new Error('metadata-write');
      },
    });
    await outbox.enqueue(envelope());
    await assert.rejects(outbox.flush(), OutboxError);
    assert.equal(await outbox.hasMarker(id()), true);
    await readFile(outbox.outboxPath(id()), 'utf8');

    failReconciliation = false;
    assert.equal((await outbox.flush()).acknowledged, 1);
    assert.equal(gatewayCalls, 1);
    assert.equal(reconciliationCalls, 2);
    await assert.rejects(readFile(outbox.outboxPath(id()), 'utf8'), { code: 'ENOENT' });
  });
});

test('acknowledgement runs after releasing the operation lock', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-outbox-ack-lock-'));
  try {
    let outbox;
    let reentered = false;
    outbox = new Outbox({
      stateDir, lockTimeoutMs: 100, lockRetryMs: 5,
      gatewayClient: { skillConversationAdd: async () => ({ status: 'ok' }) },
      onAcknowledged: async (item) => outbox.withLock(item.operation_id, async () => { reentered = true; }),
    });
    const item = envelope('a');
    await outbox.enqueue(item);
    const result = await outbox.flush({ maxItems: 1, budgetMs: 500 });
    assert.equal(result.acknowledged, 1);
    assert.equal(reentered, true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('a stale durable force operation is deleted locally before any Gateway send', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-outbox-stale-force-'));
  try {
    let calls = 0;
    const outbox = new Outbox({
      stateDir,
      shouldProcess: async (item) => item.operation_type !== 'force_archive',
      gatewayClient: { forceArchive: async () => { calls += 1; return { status: 'empty' }; } },
    });
    const operation = { operation_id: `op_sha256_${'d'.repeat(64)}`, operation_type: 'force_archive', session_id: 'session', archive_generation: 0, last_successful_capture_id: null, payload: { sessionId: 'session', reason: 'idle' } };
    await outbox.enqueueOperation(operation);
    const result = await outbox.flush({ maxItems: 1, budgetMs: 500 });
    assert.equal(result.acknowledged, 1);
    assert.equal(calls, 0);
    assert.equal(await outbox.readItemUnlocked(operation.operation_id, true), null);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
