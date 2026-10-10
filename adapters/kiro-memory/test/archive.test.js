import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArchiveService, createForceArchiveOperationId } from '../src/core/archive-service.js';
import { GatewayClient, GatewayError } from '../src/core/gateway-client.js';
import { Outbox } from '../src/core/outbox.js';

const config = { serviceId: 'svc', teamId: 'team', userId: 'user', agentId: 'agent' };

test('gateway force archive sends exact identity and accepts only archived or empty response shapes', async () => {
  const bodies = [];
  const client = new GatewayClient({ ...config, gatewayUrl: 'https://example.test', timeoutMs: 1000 }, {
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 'empty', message: 'nothing' } }) };
    },
  });
  assert.deepEqual(await client.forceArchive({ sessionId: 'session', reason: 'idle', taskId: 'turn' }), { status: 'empty' });
  assert.deepEqual(bodies[0], { session_id: 'session', space_id: 'svc', user_id: 'user', team_id: 'team', agent_id: 'agent', reason: 'idle', task_id: 'turn' });

  const bad = new GatewayClient({ ...config, gatewayUrl: 'https://example.test', timeoutMs: 1000 }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { status: 'archived', archive_key: 'x' } }) }) });
  await assert.rejects(bad.forceArchive({ sessionId: 'session' }), GatewayError);
});

test('idle archive is enqueued only after 30 minutes with no active turn or pending capture', async () => {
  const calls = [];
  const service = new ArchiveService({
    config, now: () => new Date('2026-08-16T02:00:00.000Z'),
    turnStore: { getActiveTurn: async () => null },
    outbox: { hasPendingCaptureForSession: async () => false, enqueueOperation: async (operation) => calls.push(operation) },
  });
  assert.equal(await service.considerIdle({ sessionId: 's', lastSuccessfulAppendAt: '2026-08-16T01:31:00.000Z', archiveGeneration: 1, lastSuccessfulCaptureId: 'cap_sha256_' + 'a'.repeat(64) }), false);
  assert.equal(await service.considerIdle({ sessionId: 's', lastSuccessfulAppendAt: '2026-08-16T01:30:00.000Z', archiveGeneration: 1, lastSuccessfulCaptureId: 'cap_sha256_' + 'a'.repeat(64) }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation_type, 'force_archive');
  assert.equal(calls[0].operation_id, createForceArchiveOperationId({ sessionId: 's', archiveGeneration: 1, lastSuccessfulCaptureId: 'cap_sha256_' + 'a'.repeat(64) }));

  for (const [active, pending] of [[{}, false], [null, true]]) {
    const blocked = new ArchiveService({ config, now: () => new Date('2026-08-16T02:00:00.000Z'), turnStore: { getActiveTurn: async () => active }, outbox: { hasPendingCaptureForSession: async () => pending, enqueueOperation: async () => { throw new Error('must not enqueue'); } } });
    assert.equal(await blocked.considerIdle({ sessionId: 's', lastSuccessfulAppendAt: '2026-08-16T01:00:00.000Z', archiveGeneration: 1, lastSuccessfulCaptureId: null }), false);
  }
});

test('force archive empty is acknowledged, retryable failure survives restart, and non-retryable failure is retained for review', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-outbox-'));
  const base = { operation_id: 'op_sha256_' + 'b'.repeat(64), operation_type: 'force_archive', session_id: 'session', archive_generation: 2, last_successful_capture_id: null, payload: { sessionId: 'session', reason: 'idle' } };
  try {
    let mode = 'retry';
    const gatewayClient = { forceArchive: async () => {
      if (mode === 'retry') throw new GatewayError('failed', { retryable: true });
      if (mode === 'manual') throw new GatewayError('failed', { retryable: false });
      return { status: 'empty' };
    } };
    let now = new Date('2026-08-16T00:00:00.000Z');
    const outbox = new Outbox({ stateDir, gatewayClient, now: () => now });
    await outbox.enqueueOperation(base);
    assert.equal((await outbox.flush({ maxItems: 3, budgetMs: 100 })).failed, 1);
    mode = 'ok'; now = new Date('2026-08-16T00:00:02.000Z');
    const restarted = new Outbox({ stateDir, gatewayClient, now: () => now });
    assert.equal((await restarted.flush({ maxItems: 3, budgetMs: 100 })).acknowledged, 1);
    assert.equal(await restarted.hasMarker(base.operation_id), true);

    const manual = { ...base, operation_id: 'op_sha256_' + 'c'.repeat(64), archive_generation: 3 };
    mode = 'manual'; await restarted.enqueueOperation(manual); await restarted.flush({ maxItems: 3, budgetMs: 100 });
    const stored = JSON.parse(await readFile(restarted.outboxPath(manual.operation_id), 'utf8'));
    assert.equal(stored.manual_review, true);
    assert.equal(stored.next_retry_at, null);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('server-triggered archive advances hashed session metadata and cancels the current force generation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-meta-'));
  const cancelled = [];
  try {
    const service = new ArchiveService({
      config: { ...config, stateDir }, now: () => new Date('2026-08-16T03:00:00.000Z'),
      turnStore: {}, outbox: { cancelForceOperations: async (sessionId, generation) => cancelled.push([sessionId, generation]) },
    });
    const metadata = await service.recordCaptureOutcome({
      sessionId: 'private-session', captureId: 'cap_sha256_' + 'd'.repeat(64),
      response: { status: 'archived', archived: { task_id: 't', archived_at_ms: 1786845600000, archive_key: 'key', reason: 'bytes' } },
    });
    assert.equal(metadata.session_hash.startsWith('sha256:'), true);
    assert.equal(JSON.stringify(metadata).includes('private-session'), false);
    assert.equal(metadata.archive_generation, 1);
    assert.equal(metadata.last_successful_append_at, null);
    assert.deepEqual(cancelled, [['private-session', 0]]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('an acknowledged force archive marker advances metadata and cannot retrigger from the archived append', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-force-meta-'));
  try {
    const captureId = 'cap_sha256_' + 'e'.repeat(64);
    const operationId = createForceArchiveOperationId({ sessionId: 'session', archiveGeneration: 0, lastSuccessfulCaptureId: captureId });
    const service = new ArchiveService({
      config: { ...config, stateDir }, now: () => new Date('2026-08-16T04:00:00.000Z'),
      turnStore: { getActiveTurn: async () => null },
      outbox: {
        hasPendingCaptureForSession: async () => false,
        enqueueOperation: async () => null,
        getMarker: async (id) => id === operationId ? {
          version: 2, operation_id: id, operation_type: 'force_archive', session_id: 'session',
          completed_at: '2026-08-16T03:30:00.000Z',
          result: { status: 'archived', task_id: 'turn', archived_at_ms: 1786851000000, archive_key: 'key' },
        } : null,
      },
    });
    await service.recordCaptureOutcome({ sessionId: 'session', captureId, response: { status: 'ok' } });
    const before = await service.readMetadata('session');
    assert.equal(before.archive_generation, 0);

    assert.equal(await service.considerIdle({
      sessionId: 'session', lastSuccessfulAppendAt: '2026-08-16T03:00:00.000Z',
      archiveGeneration: 0, lastSuccessfulCaptureId: captureId,
    }), false);

    const after = await service.readMetadata('session');
    assert.equal(after.archive_generation, 1);
    assert.equal(after.last_archive_at, '2026-08-16T03:30:00.000Z');
    assert.equal(after.last_successful_append_at, null);
    assert.equal(await service.considerSessionIdle('session'), false);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('archive metadata rejects unknown or content-bearing fields before any mutation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-strict-'));
  try {
    const service = new ArchiveService({ config: { ...config, stateDir }, turnStore: {}, outbox: {} });
    const path = service.metadataPath('session');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1, session_hash: `sha256:${createHash('sha256').update('session').digest('hex')}`, last_successful_append_at: null,
      last_successful_capture_id: null, last_archive_at: null, archive_generation: 0,
      content: 'must-not-be-retained',
    }));
    await assert.rejects(service.readMetadata('session'), /invalid/);
    await assert.rejects(service.recordCaptureOutcome({ sessionId: 'session', captureId: `cap_sha256_${'a'.repeat(64)}`, response: { status: 'ok' } }), /invalid/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('archive metadata rejects non-canonical timestamps and invalid capture ids', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-values-'));
  try {
    const service = new ArchiveService({ config: { ...config, stateDir }, turnStore: {}, outbox: {} });
    const path = service.metadataPath('session');
    await mkdir(join(path, '..'), { recursive: true });
    const base = { version: 1, session_hash: `sha256:${createHash('sha256').update('session').digest('hex')}`, last_successful_append_at: null, last_successful_capture_id: null, last_archive_at: null, archive_generation: 0 };
    for (const invalid of [{ ...base, last_successful_append_at: '2026-01-01' }, { ...base, last_successful_capture_id: 'capture' }]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(service.readMetadata('session'), /invalid/);
    }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('idle eligibility and archive generation update serialize so stale force work is cancelled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-archive-race-'));
  try {
    let releaseEnqueue; const enqueueReleased = new Promise((resolve) => { releaseEnqueue = resolve; });
    let enteredEnqueue; const enqueueEntered = new Promise((resolve) => { enteredEnqueue = resolve; });
    const cancelled = [];
    const service = new ArchiveService({
      config: { ...config, stateDir }, now: () => new Date('2026-08-16T02:00:00.000Z'),
      turnStore: { getActiveTurn: async () => null },
      outbox: {
        hasPendingCaptureForSession: async () => false,
        enqueueOperation: async (operation) => { enteredEnqueue(operation); await enqueueReleased; return operation; },
        cancelForceOperations: async (sessionId, generation) => { cancelled.push([sessionId, generation]); return 1; },
      },
    });
    const metadataPath = service.metadataPath('session');
    await mkdir(join(metadataPath, '..'), { recursive: true });
    await writeFile(metadataPath, JSON.stringify({
      version: 1, session_hash: `sha256:${createHash('sha256').update('session').digest('hex')}`,
      last_successful_append_at: '2026-08-16T01:00:00.000Z', last_successful_capture_id: null,
      last_archive_at: null, archive_generation: 0,
    }));
    const considering = service.considerSessionIdle('session');
    await enqueueEntered;
    let captureFinished = false;
    const capturing = service.recordCaptureOutcome({
      sessionId: 'session', captureId: `cap_sha256_${'f'.repeat(64)}`,
      response: { status: 'archived', archived: { archived_at_ms: 1786845600000 } },
    }).then(() => { captureFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureFinished, false);
    releaseEnqueue();
    assert.equal(await considering, true);
    await capturing;
    assert.deepEqual(cancelled, [['session', 0]]);
    assert.equal((await service.readMetadata('session')).archive_generation, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
