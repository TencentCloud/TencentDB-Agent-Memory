/** Engineering fixtures against the real MemoryCore SQLite + FTS store.
 * Zero provider calls. These are safety/behavior tests, not public-data scores.
 * Intended target: MemoryCore/src/core/feedback/sqlite-evidence-chain.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { VectorStore as SqliteMemoryStore, buildFtsQuery } from '../store/sqlite/memory-store.js';
import type { MemoryRecord, L1RecordRow } from '../store/types.js';
import type { EpisodicMetadata } from '../record/l1-writer.js';
import { SqliteAtomicMemoryPort } from './sqlite-atomic-port.js';
import {
  ChainRejected, SqliteEvidenceChain, type Domain, type FeedbackCommand,
} from './sqlite-evidence-chain.js';

const domain: Domain = {
  teamId: 'chain-fixture-team', userId: 'chain-fixture-user',
  agentId: 'chain-fixture-agent', taskId: '',
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const originTime = '2026-09-05T00:00:00.000Z';
type TestScope = { after: (fn: () => void) => void };
type Options = NonNullable<ConstructorParameters<typeof SqliteEvidenceChain>[2]>;
interface FixtureMetadata extends EpisodicMetadata {
  fixture: true;
  feedback_memory_scope?: 'user_memory' | 'project_memory' | 'task_experience' | null;
}

function record(id = 'MEM-01', content = 'mysqllegacy', version = 1,
  scope: Domain = domain): MemoryRecord {
  const metadata: FixtureMetadata = { fixture: true };
  return {
    id, content, version, type: 'instruction', priority: 50, scene_name: '',
    source_message_ids: ['ORIGIN-TURN'], metadata,
    timestamps: [originTime], createdAt: originTime, updatedAt: originTime,
    sessionKey: 'origin-session', sessionId: 'origin-session', ...scope,
  };
}

function fixture(t: TestScope) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-evidence-chain-'));
  const path = join(dir, 'memory.sqlite');
  const stores: SqliteMemoryStore[] = [];
  let currentMs = Date.parse(originTime);
  const open = () => {
    const store = new SqliteMemoryStore(path, 0, logger);
    store.init(); stores.push(store);
    assert.equal(store.isDegraded(), false, 'real SQLite initialization is mandatory');
    assert.equal(store.isFtsAvailable(), true, 'real FTS must run; never silently skip');
    const port = new SqliteAtomicMemoryPort(store);
    return { store, port, db: store.getRawDb() };
  };
  const initial = open();
  t.after(() => {
    for (const store of stores) store.close();
    const exact = resolve(dir);
    const root = resolve(tmpdir()) + sep;
    assert.ok(exact.startsWith(root) && exact !== resolve(tmpdir()), 'only remove owned fixture directory');
    rmSync(exact, { recursive: true, force: true });
  });
  return {
    ...initial, path, open,
    advance(ms: number) { currentMs += ms; },
    chain(options: Options = {}, connection = initial) {
      return new SqliteEvidenceChain(connection.port, connection.db, {
        mode: 'isolated', ...options, now: () => currentMs,
      });
    },
  };
}

function exact(port: SqliteAtomicMemoryPort, id = 'MEM-01', scope = domain): L1RecordRow {
  const row = port.getExact(scope, id);
  assert.ok(row, 'fixture memory must exist');
  return row;
}
function seed(chain: SqliteEvidenceChain, id = 'MEM-01', content = 'mysqllegacy') {
  return chain.seed('SEED-' + id, 'CHAIN-' + id, domain, record(id, content));
}
function compose(chain: SqliteEvidenceChain, hits: L1RecordRow[],
  overrides: Partial<Parameters<SqliteEvidenceChain['composeInjection']>[0]> = {}) {
  const result = chain.composeInjection({
    receiptId: 'RECEIPT-01', domain, sessionId: 'current-session',
    turnId: 'ANSWER-01', hits, baselineText: 'BASELINE MUST NOT BE USED', ...overrides,
  });
  // Common fixture: after the assistant's final injection, the trusted host
  // receives the next real user turn. Commands themselves do not register it.
  // Special receipts remain capture-free until a test explicitly registers one.
  if (result.mode === 'isolated' && result.receiptId === 'RECEIPT-01') {
    registerCapture(chain, command());
  }
  return result;
}
function command(patch: Partial<FeedbackCommand> = {}): FeedbackCommand {
  const text = '请将长期数据库约定改成 postgrescurrent，旧 mysqllegacy 不再使用。';
  return {
    eventId: 'EVENT-01', captureId: 'CAPTURE-01', domain, receiptId: 'RECEIPT-01', parentTurnId: 'ANSWER-01',
    targetId: 'MEM-01', expectedChainVersion: 1, expectedMemoryVersion: 1,
    kind: 'update', object: 'memory_content', directUser: true, durable: true,
    newContent: 'postgrescurrent',
    source: { role: 'user', sessionId: 'current-session', turnId: 'FEEDBACK-01',
      text, start: 0, end: Array.from(text).length, quote: text },
    ...patch,
  };
}
function registerCapture(chain: SqliteEvidenceChain, request: FeedbackCommand) {
  chain.captureUserTurn({ captureId: request.captureId, domain: request.domain,
    sessionId: request.source.sessionId, turnId: request.source.turnId,
    parentReceiptId: request.receiptId, text: request.source.text });
}
function rejectCode(fn: () => unknown, expected: string | RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ChainRejected, 'business rejection must preserve its ChainRejected type');
    if (typeof expected === 'string') assert.equal(error.message, expected, 'business rejection must preserve its fixed code');
    else assert.match(error.message, expected, 'business rejection must preserve a documented fixed code');
    return true;
  });
}
function rows(f: ReturnType<typeof fixture>, table: string) {
  const allowed = ['l1_records', 'feedback_heads', 'feedback_versions', 'feedback_events', 'feedback_receipts', 'feedback_captures', 'feedback_source_uses'];
  assert.ok(allowed.includes(table));
  return f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
}
function snapshot(f: ReturnType<typeof fixture>): string {
  return JSON.stringify(['l1_records', 'feedback_heads', 'feedback_versions', 'feedback_events', 'feedback_receipts', 'feedback_captures', 'feedback_source_uses']
    .map(table => [table, rows(f, table)]));
}
function receiptPayload(f: ReturnType<typeof fixture>, id = 'RECEIPT-01') {
  const row = f.db.prepare('SELECT payload_json FROM feedback_receipts WHERE receipt_id=?').get(id) as { payload_json: string };
  assert.ok(row);
  return JSON.parse(row.payload_json) as Array<{ memoryId: string; chainVersion: number; memoryVersion: number }>;
}

test('off/default performs zero sidecar DDL and preserves baseline UTF-8 bytes', t => {
  const f = fixture(t);
  f.port.createIfAbsent(domain, record());
  const schemaBefore = JSON.stringify(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
  const fileBefore = readFileSync(f.path);
  const chain = new SqliteEvidenceChain(f.port, f.db);
  const baselineText = '\uFEFF 原始记忆\r\n- "中文🙂"\t尾部空格  \n';
  const result = compose(chain, [exact(f.port)], { baselineText, derivedTexts: ['existing L2', 'existing L3'] });
  assert.equal(result.mode, 'off');
  assert.deepEqual(Buffer.from(result.text), Buffer.from(baselineText));
  assert.equal(result.receiptId, null);
  assert.deepEqual(chain.seed('OFF-SEED', 'OFF-CHAIN', domain, record('OFF-MEM')), { status: 'delegate_baseline', action: 'unchanged' });
  assert.deepEqual(chain.apply(command()), { status: 'delegate_baseline', action: 'unchanged' });
  assert.equal(JSON.stringify(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()), schemaBefore);
  assert.deepEqual(readFileSync(f.path), fileBefore);
  assert.equal(f.port.getExact(domain, 'OFF-MEM'), null);
  assert.equal(exact(f.port).content, 'mysqllegacy');
});

test('seed → final injection → authorized update → new injection works across sessions', t => {
  const f = fixture(t); const chain = f.chain();
  const seedRecord = { ...record(), timestamps: ['2026-09-01T00:00:00.000Z', originTime, '2026-09-06T00:00:00.000Z'] };
  assert.equal(chain.seed('SEED-MEM-01', 'CHAIN-MEM-01', domain, seedRecord).action, 'add');
  const oldHit = exact(f.port);
  const before = compose(chain, [oldHit]);
  assert.match(before.text, /mysqllegacy/);
  assert.deepEqual(before.memoryIds, ['MEM-01']);
  const result = chain.apply(command());
  assert.deepEqual(result, { status: 'applied', action: 'update', chainId: 'CHAIN-MEM-01',
    chainVersion: 2, memoryId: 'MEM-01', memoryVersion: 2 });
  const active = exact(f.port);
  assert.equal(active.session_id, 'origin-session', 'new feedback session must not rewrite immutable original provenance');
  assert.equal(active.timestamp_str, oldHit.timestamp_str);
  assert.equal(active.timestamp_start, oldHit.timestamp_start, 'update must preserve the original timestamp interval');
  assert.equal(active.timestamp_end, oldHit.timestamp_end, 'a multi-timestamp memory must not collapse to its first timestamp');
  const after = compose(chain, [oldHit, active], { receiptId: 'RECEIPT-02', sessionId: 'next-session', turnId: 'ANSWER-02' });
  assert.deepEqual(after.memoryIds, ['MEM-01'], 'a rejected stale hit must not suppress a later current hit with the same ID');
  assert.match(after.text, /postgrescurrent/); assert.doesNotMatch(after.text, /mysqllegacy/);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain).length, 0);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('postgrescurrent')!, 5, domain).length, 1);
  assert.equal(rows(f, 'feedback_versions').length, 2);
});

test('receipt includes only whole final items after duplicate, byte and k filtering', t => {
  const f = fixture(t); const chain = f.chain({ limits: { k: 2, injectionBytes: 80 } });
  seed(chain, 'MEM-01', 'one'); seed(chain, 'MEM-02', '长'.repeat(60));
  seed(chain, 'MEM-03', 'three'); seed(chain, 'MEM-04', 'four');
  f.port.createIfAbsent(domain, record('UNMANAGED', 'not adopted'));
  const result = compose(chain, [exact(f.port), exact(f.port, 'MEM-02'), exact(f.port),
    exact(f.port, 'MEM-03'), exact(f.port, 'MEM-04'), exact(f.port, 'UNMANAGED')]);
  assert.deepEqual(result.memoryIds, ['MEM-01', 'MEM-03']);
  assert.ok(Buffer.byteLength(result.text) <= 80);
  assert.equal(result.dropped, 4);
  assert.deepEqual(receiptPayload(f).map(hit => hit.memoryId), result.memoryIds);
  for (const omitted of ['MEM-02', 'MEM-04', 'UNMANAGED']) {
    rejectCode(() => chain.apply(command({ eventId: 'OMITTED-' + omitted, targetId: omitted })), 'target_not_uniquely_rendered');
  }
});

test('all four isolation dimensions bind receipt and target without foreign mutation', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  const before = snapshot(f);
  for (const dimension of ['teamId', 'userId', 'agentId', 'taskId'] as const) {
    const foreign = { ...domain, [dimension]: 'foreign-' + dimension };
    rejectCode(() => chain.apply(command({ eventId: 'FOREIGN-' + dimension, domain: foreign })), 'source_capture_mismatch');
    assert.equal(snapshot(f), before);
  }
  for (const badId of ['MEM\n01', 'M'.repeat(129)]) {
    rejectCode(() => chain.apply(command({ targetId: badId })), 'invalid_identifier');
    assert.equal(snapshot(f), before);
  }
  const filtered = compose(chain, [exact(f.port)], { receiptId: 'FOREIGN-COMPOSE', domain: { ...domain, userId: 'foreign-user' } });
  assert.equal(filtered.text, ''); assert.deepEqual(filtered.memoryIds, []);
  assert.equal(exact(f.port).content, 'mysqllegacy');
});

test('wrong receipt, parent, session, same turn, expired receipt and backward clock reject', t => {
  const f = fixture(t); const chain = f.chain({ limits: { receiptTtlMs: 100 } });
  seed(chain); compose(chain, [exact(f.port)]);
  const base = command(); const before = snapshot(f);
  for (const patch of [
    { receiptId: 'MISSING-RECEIPT' }, { parentTurnId: 'WRONG-PARENT' },
    { source: { ...base.source, sessionId: 'other-session' } },
    { source: { ...base.source, turnId: base.parentTurnId } },
  ]) rejectCode(() => chain.apply(command(patch)), 'source_capture_mismatch');
  f.advance(101);
  rejectCode(() => chain.apply(base), 'receipt_expired_or_clock_changed');
  f.advance(-102);
  rejectCode(() => chain.apply(base), 'receipt_expired_or_clock_changed');
  assert.equal(snapshot(f), before);
});

test('source role and Unicode code-point span are validated before authority is used', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  const base = command(); const before = snapshot(f);
  rejectCode(() => chain.apply(command({ source: { ...base.source, role: 'assistant' } as unknown as FeedbackCommand['source'] })), 'invalid_user_source');
  for (const source of [
    { ...base.source, quote: 'a quotation not present in the source' },
    { ...base.source, start: -1 }, { ...base.source, end: base.source.end + 1 },
    { ...base.source, end: base.source.start }, { ...base.source, start: 0.5 },
  ]) rejectCode(() => chain.apply(command({ source })), 'source_span_mismatch');
  const forgedText = '请把真实用户没有说过的话保存下来。';
  rejectCode(() => chain.apply(command({ source: { ...base.source, text: forgedText,
    quote: forgedText, start: 0, end: Array.from(forgedText).length } })), 'source_capture_mismatch');
  rejectCode(() => registerCapture(chain, { ...base, source: { ...base.source, text: forgedText } }), 'capture_id_payload_conflict');
  rejectCode(() => registerCapture(chain, { ...base, captureId: 'DUPLICATE-CAPTURE' }), 'capture_already_registered');
  assert.equal(snapshot(f), before);
  const text = '🙂把长期记录改为 postgrescurrent。';
  const quote = Array.from(text).slice(1).join('');
  compose(chain, [exact(f.port)], { receiptId: 'UNICODE-RECEIPT', turnId: 'UNICODE-ANSWER' });
  const unicodeRequest = command({ captureId: 'UNICODE-CAPTURE', receiptId: 'UNICODE-RECEIPT', parentTurnId: 'UNICODE-ANSWER',
    source: { ...base.source, turnId: 'UNICODE-FEEDBACK', text, quote, start: 1, end: Array.from(text).length } });
  registerCapture(chain, unicodeRequest);
  registerCapture(chain, base); // exact replay remains legal after a newer receipt exists
  rejectCode(() => registerCapture(chain, { ...base, captureId: 'LATE-CAPTURE',
    source: { ...base.source, turnId: 'LATE-TURN' } }), 'capture_parent_not_latest_render');
  const valid = chain.apply(unicodeRequest);
  assert.equal(valid.status, 'applied');
  const log = JSON.stringify(rows(f, 'feedback_events'));
  assert.doesNotMatch(log, /把长期记录|postgrescurrent。/u, 'event source spans must not contain raw dialogue');
  assert.match(log, /unicode_code_point/);
});

test('without direct-user durable memory-content authority no persistent change is possible', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  const before = snapshot(f);
  for (const patch of [
    { directUser: false }, { durable: false }, { object: 'answer' as const },
    { object: 'tool' as const }, { object: 'memory_retrieval' as const },
    { kind: 'retire' as const, directUser: false },
  ]) rejectCode(() => chain.apply(command(patch)), 'explicit_memory_authority_required');
  assert.equal(snapshot(f), before);
});

test('external L1 edits invalidate old receipts even if the external writer keeps the version', t => {
  for (const keepVersion of [false, true]) {
    const f = fixture(t); const chain = f.chain(); seed(chain);
    const staleHit = exact(f.port); compose(chain, [staleHit]);
    if (keepVersion) {
      assert.equal(f.store.upsertL1(record('MEM-01', 'externalreplacement', 1), undefined), true);
    } else {
      assert.equal(f.port.updateIfVersion(domain, 'MEM-01', 1, record('MEM-01', 'externalreplacement', 2)).status, 'applied');
    }
    const before = snapshot(f);
    rejectCode(() => chain.apply(command()), 'external_change_or_missing_view');
    rejectCode(() => compose(chain, [staleHit], { receiptId: 'STALE-HIT' }), 'external_change_or_missing_view');
    assert.equal(snapshot(f), before);
    assert.equal(exact(f.port).content, 'externalreplacement');
  }
});

test('metadata-only semantic scope drift rejects both update and retirement atomically', t => {
  const changes = [
    ['user_memory', 'project_memory'], ['project_memory', 'task_experience'],
    ['task_experience', 'user_memory'], [undefined, 'user_memory'],
    ['user_memory', undefined], ['user_memory', null],
  ] as const;
  for (const kind of ['update', 'retire'] as const) {
    for (const [originalScope, changedScope] of changes) {
      const f = fixture(t); const chain = f.chain();
      const metadata: FixtureMetadata = { fixture: true, ...(originalScope === undefined ? {} : { feedback_memory_scope: originalScope }) };
      chain.seed('SEED-MEM-01', 'CHAIN-MEM-01', domain, { ...record(), metadata });
      compose(chain, [exact(f.port)]);
      const original = exact(f.port);
      const changed = { fixture: true, ...(changedScope === undefined ? {} : { feedback_memory_scope: changedScope }) };
      f.db.prepare('UPDATE l1_records SET metadata_json=? WHERE record_id=?').run(JSON.stringify(changed), 'MEM-01');
      assert.equal(exact(f.port).content, original.content);
      assert.equal(exact(f.port).version, original.version, 'the regression changes only semantic metadata');
      const before = snapshot(f);
      const request = command({ kind, newContent: kind === 'update' ? 'postgrescurrent' : undefined });
      rejectCode(() => chain.apply(request), 'external_memory_scope_changed');
      assert.equal(snapshot(f), before, 'no source-use, event, version, head or L1 mutation may survive rejection');
      assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain).length, 1);
      assert.equal(f.store.searchL1Fts(buildFtsQuery('postgrescurrent')!, 5, domain).length, 0);
      f.db.prepare('UPDATE l1_records SET metadata_json=? WHERE record_id=?').run(original.metadata_json, 'MEM-01');
      assert.equal(chain.apply(request).action, kind, 'rejection must not consume the trusted capture or event ID');
    }
  }
});

test('legacy absent/null semantic scope and unrelated metadata changes remain compatible', t => {
  for (const kind of ['update', 'retire'] as const) {
    for (const originalScope of [undefined, null]) {
      for (const liveScope of [undefined, null]) {
        const f = fixture(t); const chain = f.chain();
        const metadata: FixtureMetadata = { fixture: true, ...(originalScope === undefined ? {} : { feedback_memory_scope: originalScope }) };
        chain.seed('SEED-MEM-01', 'CHAIN-MEM-01', domain, { ...record(), metadata });
        compose(chain, [exact(f.port)]);
        const compatible = { fixture: true, unrelated_note: 'external housekeeping',
          ...(liveScope === undefined ? {} : { feedback_memory_scope: liveScope }) };
        f.db.prepare('UPDATE l1_records SET metadata_json=? WHERE record_id=?').run(JSON.stringify(compatible), 'MEM-01');
        assert.equal(chain.apply(command({ kind })).action, kind);
        if (kind === 'update') {
          assert.deepEqual(JSON.parse(exact(f.port).metadata_json), compatible);
          assert.equal(exact(f.port).content, 'postgrescurrent');
        } else assert.equal(f.port.getExact(domain, 'MEM-01'), null);
      }
    }
  }
});

test('successful update and retirement replay precede semantic scope and live-view checks', t => {
  const f = fixture(t); const chain = f.chain();
  const metadata: FixtureMetadata = { fixture: true, feedback_memory_scope: 'project_memory' };
  chain.seed('SEED-MEM-01', 'CHAIN-MEM-01', domain, { ...record(), metadata });
  compose(chain, [exact(f.port)]);
  const updateRequest = command(); const updated = chain.apply(updateRequest);
  const currentMetadata = exact(f.port).metadata_json;
  f.db.prepare('UPDATE l1_records SET metadata_json=? WHERE record_id=?')
    .run(JSON.stringify({ fixture: true, feedback_memory_scope: 'user_memory' }), 'MEM-01');
  const drifted = snapshot(f);
  assert.deepEqual(chain.apply(updateRequest), updated, 'a prior result is replayed, never applied again');
  assert.equal(snapshot(f), drifted);
  f.db.prepare('UPDATE l1_records SET metadata_json=? WHERE record_id=?').run(currentMetadata, 'MEM-01');
  compose(chain, [exact(f.port)], { receiptId: 'RETIRE-RECEIPT', turnId: 'RETIRE-ANSWER' });
  const retireRequest = command({ eventId: 'RETIRE-EVENT', captureId: 'RETIRE-CAPTURE',
    receiptId: 'RETIRE-RECEIPT', parentTurnId: 'RETIRE-ANSWER', kind: 'retire', newContent: undefined,
    expectedChainVersion: 2, expectedMemoryVersion: 2,
    source: { ...updateRequest.source, turnId: 'RETIRE-FEEDBACK' } });
  registerCapture(chain, retireRequest);
  const retired = chain.apply(retireRequest); const afterRetire = snapshot(f);
  assert.equal(f.port.getExact(domain, 'MEM-01'), null);
  f.advance(1800001);
  assert.deepEqual(chain.apply(retireRequest), retired, 'retirement replay needs no live L1 row or unexpired receipt');
  assert.deepEqual(chain.apply(updateRequest), updated, 'an old successful update remains replayable after retirement');
  assert.equal(snapshot(f), afterRetire);
});

test('seed and feedback event replay are idempotent; same ID with changed payload rejects', t => {
  const f = fixture(t); const chain = f.chain();
  const added = seed(chain); const afterSeed = snapshot(f);
  assert.deepEqual(seed(chain), added); assert.equal(snapshot(f), afterSeed);
  rejectCode(() => seed(chain, 'MEM-01', 'changedseed'), 'event_id_payload_conflict');
  compose(chain, [exact(f.port)]);
  const request = command(); const applied = chain.apply(request); const afterUpdate = snapshot(f);
  assert.deepEqual(chain.apply(request), applied); assert.equal(snapshot(f), afterUpdate);
  rejectCode(() => chain.apply({ ...request, newContent: 'differentpayload' }), 'event_id_payload_conflict');
  rejectCode(() => chain.apply({ ...request, eventId: 'SECOND-MUTATION-SAME-CAPTURE', newContent: 'notanotherwrite' }),
    'stale_receipt');
  assert.equal(snapshot(f), afterUpdate);
  // A different target still cannot evade the single-mutation-per-user-turn
  // guard. Both targets really appeared in the same final injected receipt.
  const secondFixture = fixture(t); const secondChain = secondFixture.chain();
  seed(secondChain); seed(secondChain, 'MEM-02', 'secondoriginal');
  compose(secondChain, [exact(secondFixture.port), exact(secondFixture.port, 'MEM-02')]);
  secondChain.apply(command());
  rejectCode(() => secondChain.apply(command({ eventId: 'OTHER-TARGET-SAME-TURN', targetId: 'MEM-02' })), 'source_turn_already_used');
  assert.equal(exact(secondFixture.port, 'MEM-02').content, 'secondoriginal');
});

test('weak, diagnostic, support and refute events are recorded NOOPs, never silent writes', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  const rowBefore = JSON.stringify(exact(f.port));
  for (const kind of ['defer', 'diagnostic', 'support', 'refute'] as const) {
    const request = command({ eventId: 'EVENT-' + kind, kind,
      object: kind === 'diagnostic' ? 'answer' : 'memory_content' });
    if (kind === 'refute') {
      compose(chain, [exact(f.port)], { receiptId: 'REFUTE-RECEIPT', turnId: 'REFUTE-ANSWER' });
      Object.assign(request, { captureId: 'REFUTE-CAPTURE', receiptId: 'REFUTE-RECEIPT', parentTurnId: 'REFUTE-ANSWER',
        source: { ...request.source, turnId: 'REFUTE-TURN' } });
      registerCapture(chain, request);
    }
    const result = chain.apply(request);
    assert.equal(result.status, 'recorded'); assert.equal(result.action, 'noop');
    assert.equal(JSON.stringify(exact(f.port)), rowBefore);
  }
  assert.equal(rows(f, 'feedback_versions').length, 1);
  assert.equal(rows(f, 'feedback_events').length, 5);
  assert.equal((rows(f, 'feedback_heads')[0] as { evidence_count: number }).evidence_count, 2);
  rejectCode(() => chain.apply(command({ eventId: 'REPEATED-SUPPORT', kind: 'support' })), 'source_turn_already_used');
});

test('retirement removes the active L1/FTS view but preserves clearly non-renderable audit history', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain);
  const oldHit = exact(f.port); compose(chain, [oldHit]);
  const retired = chain.apply(command({ kind: 'retire', newContent: undefined }));
  assert.equal(retired.action, 'retire'); assert.equal(retired.chainVersion, 2);
  assert.equal(f.port.getExact(domain, 'MEM-01'), null);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain).length, 0);
  const result = compose(chain, [oldHit], { receiptId: 'AFTER-RETIRE', turnId: 'ANSWER-02' });
  assert.equal(result.text, ''); assert.deepEqual(result.memoryIds, []);
  const history = rows(f, 'feedback_versions') as Array<{ state: string; record_snapshot: string }>;
  assert.equal(history.length, 2); assert.match(history[0].record_snapshot, /mysqllegacy/);
  assert.equal(history[1].state, 'retired'); assert.equal(history[1].record_snapshot, 'null');
  const retiredRequest = command({ eventId: 'AFTER-RETIRE-UPDATE', captureId: 'AFTER-RETIRE-CAPTURE', receiptId: 'AFTER-RETIRE',
    parentTurnId: 'ANSWER-02', expectedChainVersion: 2, expectedMemoryVersion: 2,
    source: { ...command().source, turnId: 'FEEDBACK-02' } });
  registerCapture(chain, retiredRequest);
  rejectCode(() => chain.apply(retiredRequest), 'target_not_uniquely_rendered');
  // This proves logical retirement, explicitly not physical privacy erasure.
});

test('the real composer refuses L2/L3 derived text rather than quietly dropping unsafe layers', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain);
  const before = snapshot(f);
  // SQLite upstream does not persist L2/L3 profile rows. These are interface
  // fixtures at the real composition boundary, not a Hermes integration test.
  for (const derivedTexts of [['L2 scenario still says mysqllegacy'], ['L3 core profile still says mysqllegacy'],
    ['L2 old scenario', 'L3 old core profile']]) {
    rejectCode(() => compose(chain, [exact(f.port)], { derivedTexts }), 'derived_layers_not_supported_in_isolated_mode');
    assert.equal(snapshot(f), before);
  }
});

test('capacity gates reject complete operations and reserve a terminal tombstone version', t => {
  {
    const f = fixture(t);
    rejectCode(() => f.chain({ limits: { evidencePerChain: 1 } as unknown as Options['limits'] }), 'unknown_capacity_option');
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { chains: 1 } }); seed(chain);
    const before = snapshot(f);
    rejectCode(() => seed(chain, 'MEM-02'), 'chain_capacity'); assert.equal(snapshot(f), before);
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { events: 1 } }); seed(chain); compose(chain, [exact(f.port)]);
    const before = snapshot(f);
    rejectCode(() => chain.apply(command()), 'event_capacity'); assert.equal(snapshot(f), before);
    assert.equal(chain.apply(command({ eventId: 'RESERVED-RETIRE', kind: 'retire' })).action, 'retire', 'terminal event has its own bounded reserve');
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { receipts: 1 } }); seed(chain); compose(chain, [exact(f.port)]);
    const before = snapshot(f);
    rejectCode(() => compose(chain, [exact(f.port)], { receiptId: 'SECOND' }), 'receipt_capacity'); assert.equal(snapshot(f), before);
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { candidateK: 1, k: 1 } }); seed(chain);
    rejectCode(() => compose(chain, [exact(f.port), exact(f.port)]), 'candidate_capacity');
    assert.equal(rows(f, 'feedback_receipts').length, 0);
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { evidencePerVersion: 1, versionsPerChain: 1 } });
    seed(chain); compose(chain, [exact(f.port)]);
    chain.apply(command({ eventId: 'ONE-SUPPORT', kind: 'support' }));
    rejectCode(() => chain.apply(command({ eventId: 'SECOND-SUPPORT', kind: 'support' })), 'evidence_capacity');
    rejectCode(() => chain.apply(command()), 'version_capacity');
    assert.equal(chain.apply(command({ eventId: 'RETIRE-AT-CAP', kind: 'retire' })).action, 'retire');
    assert.equal(rows(f, 'feedback_versions').length, 2);
  }
  {
    const f = fixture(t); const chain = f.chain({ limits: { inputBytes: 8 } }); seed(chain);
    compose(chain, [exact(f.port)], { receiptId: 'SMALL-SOURCE-RECEIPT' });
    rejectCode(() => chain.apply(command()), 'invalid_user_source');
    assert.equal(exact(f.port).version, 1);
  }
});

test('late event-insert failure rolls active memory, FTS, chain head and version history back', t => {
  const f = fixture(t); const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  f.db.exec("CREATE TRIGGER reject_fixture_event BEFORE INSERT ON feedback_events WHEN NEW.event_id='ROLLBACK-EVENT' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END");
  const before = snapshot(f);
  assert.throws(() => chain.apply(command({ eventId: 'ROLLBACK-EVENT' })), /atomic_port_operation_failed/);
  assert.equal(snapshot(f), before);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain).length, 1);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('postgrescurrent')!, 5, domain).length, 0);
  f.db.exec('DROP TRIGGER reject_fixture_event');
  assert.equal(chain.apply(command({ eventId: 'ROLLBACK-EVENT' })).status, 'applied', 'failed event did not leave a ghost idempotency entry');
});

test('restart preserves receipt binding, version history and successful-event idempotency', t => {
  const f = fixture(t); const first = f.chain(); seed(first); compose(first, [exact(f.port)]);
  f.store.close();
  const reopened = f.open(); const second = f.chain({}, reopened);
  const request = command(); const result = second.apply(request);
  assert.equal(result.chainVersion, 2);
  reopened.store.close();
  const again = f.open(); const third = f.chain({}, again);
  assert.deepEqual(third.apply(request), result);
  assert.equal(exact(again.port).content, 'postgrescurrent');
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM feedback_versions').get()?.n, 2);
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM feedback_events').get()?.n, 2);
});

test('two real SQLite connections cannot both accept the same stale receipt/version', t => {
  const f = fixture(t); const first = f.chain(); seed(first); compose(first, [exact(f.port)]);
  const peerConnection = f.open(); const peer = f.chain({}, peerConnection);
  assert.equal(exact(peerConnection.port).version, 1);
  const winner = first.apply(command({ eventId: 'WINNER' }));
  assert.equal(winner.status, 'applied');
  rejectCode(() => peer.apply(command({ eventId: 'LOSER', newContent: 'staleresult' })), 'stale_receipt');
  assert.equal(exact(peerConnection.port).content, 'postgrescurrent');
  assert.equal(peerConnection.db.prepare("SELECT count(*) AS n FROM feedback_events WHERE event_id='LOSER'").get()?.n, 0);
  assert.equal(peerConnection.db.prepare('SELECT count(*) AS n FROM feedback_versions').get()?.n, 2);
});

test('mismatched database handles and modification of immutable evidence are rejected', t => {
  const f = fixture(t); const second = f.open();
  rejectCode(() => new SqliteEvidenceChain(f.port, second.db, { mode: 'isolated' }), 'same_sqlite_connection_required');
  const chain = f.chain(); seed(chain); compose(chain, [exact(f.port)]);
  for (const table of ['feedback_versions', 'feedback_events', 'feedback_receipts', 'feedback_captures']) {
    assert.throws(() => f.db.exec('DELETE FROM ' + table), /immutable_/);
  }
  assert.equal(exact(f.port).version, 1);
});
