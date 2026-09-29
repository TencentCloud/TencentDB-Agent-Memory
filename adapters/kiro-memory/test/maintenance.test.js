import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { StateMaintenanceService } from '../src/core/state-maintenance.js';
import { maintenanceExitCode } from '../scripts/maintenance.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const validTurn = ({ sessionId, turnId, pending = false }) => ({
  version: 2, turn_id: turnId, session_id: sessionId, prompt: 'prompt', prompt_hash: `sha256:${digest('prompt')}`,
  created_at: '2026-06-01T00:00:00.000Z', completed_at: pending ? null : '2026-06-01T00:01:00.000Z',
  lifecycle_status: pending ? 'pending' : 'completed', capture_status: pending ? 'not_started' : 'full_captured',
  assistant_observation: { available: false, content: null }, tool_events: [], capture_id: null,
});
const validForceOutbox = (id, sessionId = 'session') => ({
  version: 2, operation_id: id, operation_type: 'force_archive', session_id: sessionId, turn_id: null,
  archive_generation: 0, last_successful_capture_id: null, created_at: '2026-06-01T00:00:00.000Z',
  attempt_count: 0, next_retry_at: null, manual_review: false, payload: { sessionId, reason: 'idle' },
});
const validMarker = (id, { sessionId = 'session', turnId } = {}) => ({
  version: 2, operation_id: id, completed_at: '2026-06-01T00:00:00.000Z',
  operation_type: turnId ? 'skill_conversation' : 'force_archive', session_id: sessionId,
  ...(turnId ? { turn_id: turnId } : {}), result: turnId ? { status: 'ok' } : { status: 'empty' },
});

test('truncated maintenance dry-runs use a non-zero exit code', () => {
  assert.equal(maintenanceExitCode({ truncated: true }), 1);
  assert.equal(maintenanceExitCode({ truncated: false }), 0);
});

test('maintenance is dry-run by default and only proposes safe categories', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-'));
  try {
    const corrupt = join(stateDir, 'sessions', 'hash', 'turns', 'corrupt.json');
    const lock = join(stateDir, 'sessions', 'hash', '.turn-state.lock');
    const pending = join(stateDir, 'outbox', `cap_sha256_${'a'.repeat(64)}.json`);
    await mkdir(join(stateDir, 'sessions', 'hash', 'turns'), { recursive: true });
    await mkdir(join(stateDir, 'outbox'), { recursive: true });
    await writeFile(corrupt, '{bad');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), `${JSON.stringify({
      version: 2,
      owner_token: 'expired-owner',
      pid: 12345,
      hostname: 'test-host',
      created_at: '2026-06-01T00:00:00.000Z',
      heartbeat_at: '2026-06-01T00:00:01.000Z',
    })}\n`);
    await writeFile(pending, JSON.stringify(validForceOutbox(`cap_sha256_${'a'.repeat(64)}`)));
    const before = await readFile(corrupt, 'utf8');
    const plan = await new StateMaintenanceService({
      stateDir,
      lockInspectionOptions: {
        staleAfterMs: 1_000,
        nowMs: () => Date.parse('2026-06-01T00:01:00.000Z'),
        currentHostname: 'test-host',
        getProcessState: () => 'dead',
      },
    }).plan();
    assert.equal(plan.items.find((item) => item.path.endsWith('corrupt.json')).action, 'quarantine');
    const lockItem = plan.items.find((item) => item.path.endsWith('.lock'));
    assert.equal(lockItem.action, 'report');
    assert.equal(lockItem.category, 'stale_reclaimable_lock');
    assert.equal(JSON.stringify(lockItem).includes('expired-owner'), false);
    assert.equal(plan.items.some((item) => item.path.endsWith('/owner')), false);
    assert.equal(plan.items.find((item) => item.path.includes('outbox/')).action, 'retain');
    assert.equal(await readFile(corrupt, 'utf8'), before);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('apply revalidates size mtime and hash, quarantines unchanged corrupt JSON, and skips changed objects', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-apply-'));
  try {
    const first = join(stateDir, 'bad-one.json');
    const changed = join(stateDir, 'bad-two.json');
    await writeFile(first, '{one'); await writeFile(changed, '{two');
    const service = new StateMaintenanceService({ stateDir });
    const plan = await service.plan();
    await writeFile(changed, '{changed-and-longer');
    const result = await service.apply(plan);
    assert.equal(result.quarantined, 1);
    assert.equal(result.skipped, 1);
    await assert.rejects(lstat(first), { code: 'ENOENT' });
    assert.equal(await readFile(changed, 'utf8'), '{changed-and-longer');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('truncated scans refuse apply', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-limit-'));
  try {
    await writeFile(join(stateDir, 'a.json'), '{}'); await writeFile(join(stateDir, 'b.json'), '{}');
    const service = new StateMaintenanceService({ stateDir, maxObjects: 1 });
    const plan = await service.plan();
    assert.equal(plan.truncated, true);
    await assert.rejects(service.apply(plan), /incomplete/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('directories count toward the bounded maintenance scan and are reported without mutation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-directories-'));
  try {
    await mkdir(join(stateDir, 'a', 'b', 'c'), { recursive: true });
    const service = new StateMaintenanceService({ stateDir, maxObjects: 2 });
    const plan = await service.plan();
    assert.equal(plan.truncated, true);
    assert.equal(plan.items.some((item) => item.object_kind === 'directory' && item.action === 'report'), true);
    await assert.rejects(service.apply(plan), /incomplete/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('structurally invalid known state is quarantined even when its JSON parses', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-invalid-state-'));
  try {
    const sessionHash = createHash('sha256').update('session').digest('hex');
    const path = join(stateDir, 'sessions', sessionHash, 'active.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, session_id: 'wrong', active_turn_id: 'turn' }));
    const plan = await new StateMaintenanceService({ stateDir }).plan();
    const item = plan.items.find((candidate) => candidate.path.endsWith('/active.json'));
    assert.equal(item.category, 'invalid_state');
    assert.equal(item.action, 'quarantine');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('an old pending turn referenced by the active pointer is retained', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-active-'));
  try {
    const sessionId = 'private-session';
    const session = join(stateDir, 'sessions', digest(sessionId));
    await mkdir(join(session, 'turns'), { recursive: true });
    await writeFile(join(session, 'active.json'), JSON.stringify({ version: 1, session_id: sessionId, active_turn_id: 'turn-active' }));
    await writeFile(join(session, 'turns', 'turn-active.json'), JSON.stringify({ ...validTurn({ sessionId, turnId: 'turn-active', pending: true }), created_at: '2026-08-14T00:00:00.000Z' }));
    const plan = await new StateMaintenanceService({ stateDir, now: () => new Date('2026-08-16T00:00:00.000Z') }).plan();
    const item = plan.items.find((candidate) => candidate.path.endsWith('turn-active.json'));
    assert.equal(item.category, 'active_pending_turn');
    assert.equal(item.action, 'retain');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('successful duplicate outbox and old orphan markers are quarantined while related markers remain', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-markers-'));
  try {
    const duplicateId = `cap_sha256_${'a'.repeat(64)}`;
    const orphanId = `cap_sha256_${'b'.repeat(64)}`;
    const relatedId = `cap_sha256_${'c'.repeat(64)}`;
    await mkdir(join(stateDir, 'outbox'), { recursive: true });
    await mkdir(join(stateDir, 'captured'), { recursive: true });
    const sessionId = 'session'; const hash = digest(sessionId);
    await mkdir(join(stateDir, 'sessions', hash, 'turns'), { recursive: true });
    await writeFile(join(stateDir, 'outbox', `${duplicateId}.json`), JSON.stringify(validForceOutbox(duplicateId, sessionId)));
    await writeFile(join(stateDir, 'captured', `${duplicateId}.json`), JSON.stringify(validMarker(duplicateId, { sessionId })));
    await writeFile(join(stateDir, 'captured', `${orphanId}.json`), JSON.stringify(validMarker(orphanId, { sessionId, turnId: 'missing' })));
    await writeFile(join(stateDir, 'captured', `${relatedId}.json`), JSON.stringify(validMarker(relatedId, { sessionId, turnId: 'retained-turn' })));
    await writeFile(join(stateDir, 'sessions', hash, 'turns', 'retained-turn.json'), JSON.stringify(validTurn({ sessionId, turnId: 'retained-turn' })));

    const plan = await new StateMaintenanceService({ stateDir, now: () => new Date('2026-08-16T00:00:00.000Z') }).plan();
    assert.equal(plan.items.find((item) => item.path === `outbox/${duplicateId}.json`).category, 'redundant_success_outbox');
    assert.equal(plan.items.find((item) => item.path === `outbox/${duplicateId}.json`).action, 'quarantine');
    assert.equal(plan.items.find((item) => item.path === `captured/${orphanId}.json`).category, 'orphan_marker');
    assert.equal(plan.items.find((item) => item.path === `captured/${relatedId}.json`).action, 'retain');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('apply considers idle archive only for a turn whose session id matches its hashed directory', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-maintenance-idle-'));
  try {
    const sessionId = 'private-session';
    const sessionHash = createHash('sha256').update(sessionId).digest('hex');
    const session = join(stateDir, 'sessions', sessionHash);
    await mkdir(join(session, 'turns'), { recursive: true });
    await writeFile(join(session, 'archive.json'), JSON.stringify({ version: 1, session_hash: `sha256:${sessionHash}`, last_successful_append_at: null, last_successful_capture_id: null, last_archive_at: null, archive_generation: 0 }));
    await writeFile(join(session, 'turns', 'turn.json'), JSON.stringify({ ...validTurn({ sessionId, turnId: 'turn' }), completed_at: '2026-08-16T00:01:00.000Z' }));
    await mkdir(join(stateDir, 'sessions', 'wrong-hash', 'turns'), { recursive: true });
    await writeFile(join(stateDir, 'sessions', 'wrong-hash', 'archive.json'), '{}');
    await writeFile(join(stateDir, 'sessions', 'wrong-hash', 'turns', 'turn.json'), JSON.stringify({ session_id: 'must-not-use' }));
    const considered = [];
    const service = new StateMaintenanceService({
      stateDir,
      archiveService: { considerSessionIdle: async (id) => { considered.push(id); return true; } },
    });
    const result = await service.apply(await service.plan());
    assert.deepEqual(considered, [sessionId]);
    assert.equal(result.idleArchivesEnqueued, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
