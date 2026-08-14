import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Outbox, OutboxError } from '../src/core/outbox.js';

const id = (suffix = 'a') => `cap_sha256_${suffix.repeat(64)}`;
const payload = (suffix = 'a') => ({ session_id: `session-${suffix}`, team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: `turn-${suffix}`, messages: [{ role: 'user', content: suffix }] });
const envelope = (suffix = 'a') => ({ capture_id: id(suffix), type: 'skill_conversation', session_id: `session-${suffix}`, turn_id: `turn-${suffix}`, payload: payload(suffix) });
const withStateDir = async (run) => { const stateDir = await mkdtemp(join(tmpdir(), 'kiro-outbox-')); try { await run(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); } };

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
    assert.equal(JSON.parse(await readFile(outbox.markerPath(id()), 'utf8')).capture_id, id());
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
