/** Real SQLite bridge engineering tests; no provider, HTTP, .env or public data. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BRIDGE_LIMITS, IsolatedChainBridge, parseBridgeArgs, runBridgeCli, type BridgeResponse, type ReceiptContext } from './chain-stdio-bridge.js';
import { DEFAULT_CHAIN_LIMITS } from './sqlite-evidence-chain.js';

const scope = { teamId: 'bridge-team', userId: 'bridge-user', agentId: 'bridge-agent', taskId: '' };
type TestScope = { after: (fn: () => void) => void };
function fixture(t: TestScope) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-chain-stdio-'));
  const path = join(dir, 'isolated.sqlite'); const bridges: IsolatedChainBridge[] = [];
  let clock = Date.parse('2026-09-05T00:00:00Z');
  t.after(() => {
    for (const bridge of bridges) bridge.close();
    const owned = resolve(dir); const root = resolve(tmpdir()) + sep;
    assert.ok(owned.startsWith(root) && owned !== resolve(tmpdir()));
    rmSync(owned, { recursive: true, force: true });
  });
  return { dir, path,
    advance(ms: number) { clock += ms; },
    open() { const bridge = new IsolatedChainBridge({ isolated: true, dbPath: path, scope, now: () => clock }); bridges.push(bridge); return bridge; },
    argv() { return ['--isolated', '--db', path, '--scope', JSON.stringify(scope)]; },
  };
}
function send(bridge: IsolatedChainBridge, operation: string, args: unknown, id = 'REQUEST-01') {
  return bridge.processLine(JSON.stringify({ id, operation, args }));
}
function seed(bridge: IsolatedChainBridge, memoryId = 'MEM-01', content = 'database mysqllegacy') {
  return send(bridge, 'seed', { eventId: 'SEED-' + memoryId, chainId: 'CHAIN-' + memoryId,
    memoryId, content, sessionId: 'origin-session', turnId: 'origin-turn' });
}
function compose(bridge: IsolatedChainBridge, query = 'database', receiptId = 'RECEIPT-01', turnId = 'ANSWER-01') {
  return send(bridge, 'compose', { query, receiptId, sessionId: 'current-session', turnId });
}
function capture(bridge: IsolatedChainBridge, text = '请把长期数据库改为 postgrescurrent。') {
  return send(bridge, 'capture', { captureId: 'CAPTURE-01', sessionId: 'current-session',
    turnId: 'USER-01', parentReceiptId: 'RECEIPT-01', text });
}
function updateArgs(text = '请把长期数据库改为 postgrescurrent。') {
  return { eventId: 'UPDATE-01', captureId: 'CAPTURE-01', receiptId: 'RECEIPT-01', parentTurnId: 'ANSWER-01',
    targetId: 'MEM-01', expectedChainVersion: 1, expectedMemoryVersion: 1,
    kind: 'update', object: 'memory_content', directUser: true, durable: true,
    newContent: 'database postgrescurrent', source: { role: 'user', sessionId: 'current-session',
      turnId: 'USER-01', text, start: 0, end: Array.from(text).length, quote: text } };
}
function data<T>(response: BridgeResponse): T {
  assert.equal(response.status, 'pass', JSON.stringify(response)); assert.equal(response.code, 'ok');
  assert.equal(response.cost.provider_calls, 0); return response.data as T;
}

function receiptContext(bridge: IsolatedChainBridge, receiptId = 'RECEIPT-01', parentTurnId = 'ANSWER-01') {
  return send(bridge, 'receipt_context', { receiptId, sessionId: 'current-session', parentTurnId });
}
function seedScoped(bridge: IsolatedChainBridge, memoryScope: unknown, memoryId = 'MEM-01', content = 'database mysqllegacy') {
  return send(bridge, 'seed', { eventId: 'SEED-' + memoryId, chainId: 'CHAIN-' + memoryId,
    memoryId, content, sessionId: 'origin-session', turnId: 'origin-turn', memoryScope });
}
function storedFixture(path: string) {
  const db = new DatabaseSync(path);
  try {
    const receipt = db.prepare('SELECT * FROM feedback_receipts WHERE receipt_id=?').get('RECEIPT-01') as
      { domain_json: string; session_id: string; turn_id: string; created_ms: number; payload_json: string };
    const version = db.prepare('SELECT * FROM feedback_versions WHERE chain_id=? AND chain_version=1').get('CHAIN-MEM-01') as
      { record_snapshot: string; content_hash: string };
    return { receipt, version, binding: JSON.parse(receipt.payload_json)[0] as Record<string, unknown>,
      row: JSON.parse(version.record_snapshot) as Record<string, unknown> };
  } finally { db.close(); }
}
function insertFixtureReceipt(path: string, id: string, payload: string, overrides: Record<string, unknown> = {}) {
  const db = new DatabaseSync(path);
  try {
    const original = db.prepare('SELECT * FROM feedback_receipts WHERE receipt_id=?').get('RECEIPT-01')!;
    db.prepare('INSERT INTO feedback_receipts VALUES(?,?,?,?,?,?)').run(id,
      (overrides.domain_json ?? original.domain_json) as string,
      (overrides.session_id ?? original.session_id) as string,
      (overrides.turn_id ?? original.turn_id) as string,
      (overrides.created_ms ?? original.created_ms) as number, payload);
  } finally { db.close(); }
}
function insertFixtureVersion(path: string, id: string, snapshot: string, fingerprint: string, state = 'active') {
  const db = new DatabaseSync(path);
  try { db.prepare('INSERT INTO feedback_versions VALUES(?,?,?,?,?,?,?,?)').run(id, 1, null, snapshot,
    fingerprint, state, '{}', 'EVENT-' + id); } finally { db.close(); }
}

test('receipt_context is repeatable and read-only, with semantic scope independent of record type', t => {
  const f = fixture(t); const bridge = f.open();
  for (const [index, semanticScope] of ['user_memory', 'project_memory', 'task_experience'].entries()) {
    data(seedScoped(bridge, semanticScope, 'MEM-' + index));
  }
  data(seed(bridge, 'MEM-UNSPECIFIED'));
  data(compose(bridge));
  const db = new DatabaseSync(f.path, { readOnly: true });
  const snapshot = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").all();
  const tableCounts = () => ['feedback_events', 'feedback_receipts', 'feedback_versions', 'feedback_captures', 'l1_records']
    .map(table => db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n);
  try {
    const schemaBefore = snapshot(); const countsBefore = tableCounts();
    const first = data<ReceiptContext>(receiptContext(bridge));
    assert.deepEqual(first.domain, scope); assert.equal(first.receiptId, 'RECEIPT-01');
    assert.equal(first.sessionId, 'current-session'); assert.equal(first.parentTurnId, 'ANSWER-01');
    assert.equal(first.targets.length, 4);
    const scopes = Object.fromEntries(first.targets.map(target => [target.memoryId, target.memory_scope]));
    assert.deepEqual(scopes, { 'MEM-0': 'user_memory', 'MEM-1': 'project_memory', 'MEM-2': 'task_experience', 'MEM-UNSPECIFIED': null });
    assert.ok(first.targets.every(target => target.chainVersion === 1 && target.memoryVersion === 1));
    assert.deepEqual(data(receiptContext(bridge)), first);
    assert.deepEqual(tableCounts(), countsBefore); assert.deepEqual(snapshot(), schemaBefore);
  } finally { db.close(); }
});

test('optional seed memoryScope preserves legacy replay and rejects unsupported semantic labels', t => {
  const f = fixture(t); const bridge = f.open(); const original = data(seed(bridge));
  assert.deepEqual(data(seedScoped(bridge, null)), original, 'null and omitted scope have identical legacy metadata');
  assert.equal(seedScoped(bridge, 'project_memory').code, 'event_id_payload_conflict');
  for (const value of ['none', 'current_turn', 'unknown', 'instruction', {}, [], 1, true]) {
    assert.equal(seedScoped(bridge, value, 'MEM-INVALID').code, 'invalid_memory_scope');
  }
  data(compose(bridge));
  assert.equal(data<ReceiptContext>(receiptContext(bridge)).targets[0].memory_scope, null);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const row = db.prepare('SELECT metadata_json FROM l1_records WHERE record_id=?').get('MEM-01')!;
    assert.deepEqual(JSON.parse(row.metadata_json as string), { source: 'isolated_stdio_bridge' });
  } finally { db.close(); }
});

test('receipt_context keeps old immutable content and scope after chain updates and external live changes', t => {
  const f = fixture(t); const bridge = f.open(); data(seedScoped(bridge, 'project_memory')); data(compose(bridge));
  const oldContext = data<ReceiptContext>(receiptContext(bridge));
  data(capture(bridge)); data(send(bridge, 'apply', updateArgs()));
  data(compose(bridge, 'database', 'RECEIPT-02', 'ANSWER-02'));
  const updated = data<ReceiptContext>(receiptContext(bridge, 'RECEIPT-02', 'ANSWER-02'));
  assert.equal(updated.targets[0].content, 'database postgrescurrent');
  assert.equal(updated.targets[0].memoryVersion, 2); assert.equal(updated.targets[0].chainVersion, 2);
  assert.equal(updated.targets[0].memory_scope, 'project_memory');
  assert.deepEqual(data(receiptContext(bridge)), oldContext, 'historical receipt remains version 1');
  const peer = new DatabaseSync(f.path);
  try { peer.prepare('UPDATE l1_records SET content=?,version=?,metadata_json=? WHERE record_id=?')
    .run('external unrelated live content', 9, JSON.stringify({ feedback_memory_scope: 'user_memory' }), 'MEM-01'); }
  finally { peer.close(); }
  assert.deepEqual(data(receiptContext(bridge)), oldContext);
  assert.deepEqual(data(receiptContext(bridge, 'RECEIPT-02', 'ANSWER-02')), updated);
  assert.equal(oldContext.targets[0].content, 'database mysqllegacy');
});

test('receipt_context checks exact session, parent and all four physical domain dimensions', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge)); data(compose(bridge));
  const args = { receiptId: 'RECEIPT-01', sessionId: 'current-session', parentTurnId: 'ANSWER-01' };
  for (const patch of [{ sessionId: 'other-session' }, { parentTurnId: 'other-parent' }, { receiptId: 'MISSING' }]) {
    assert.equal(send(bridge, 'receipt_context', { ...args, ...patch }).code, 'receipt_context_mismatch');
  }
  for (const patch of [{ domain: scope }, { scope }, { k: 5 }, { sql: 'SELECT *' }, { targets: [] }]) {
    assert.equal(send(bridge, 'receipt_context', { ...args, ...patch }).code, 'unknown_field');
  }
  const original = storedFixture(f.path);
  for (const field of ['teamId', 'userId', 'agentId', 'taskId'] as const) {
    const foreign = { ...scope, [field]: 'foreign-' + field };
    insertFixtureReceipt(f.path, 'FOREIGN-' + field, original.receipt.payload_json,
      { domain_json: JSON.stringify([foreign.teamId, foreign.userId, foreign.agentId, foreign.taskId]) });
    assert.equal(receiptContext(bridge, 'FOREIGN-' + field).code, 'receipt_context_mismatch');
  }
  assert.equal(send(bridge, 'receipt_context', { ...args, sessionId: 'bad\nidentifier' }).code, 'invalid_identifier');
});

test('receipt_context returns only final k/byte-limited injected items, and accepts an empty final receipt', t => {
  const f = fixture(t); const bridge = f.open();
  for (let i = 0; i < 7; i++) data(seedScoped(bridge, null, 'SMALL-' + i));
  const composed = data<{ memoryIds: string[] }>(compose(bridge));
  const context = data<ReceiptContext>(receiptContext(bridge));
  assert.equal(context.targets.length, 5); assert.deepEqual(context.targets.map(x => x.memoryId), composed.memoryIds);
  data(compose(bridge, 'nonexistentterm', 'EMPTY', 'EMPTY-ANSWER'));
  assert.deepEqual(data<ReceiptContext>(receiptContext(bridge, 'EMPTY', 'EMPTY-ANSWER')).targets, []);
  for (let i = 0; i < 3; i++) data(seedScoped(bridge, 'project_memory', 'LARGE-' + i, 'largequery ' + 'x'.repeat(4085)));
  const large = data<{ memoryIds: string[] }>(compose(bridge, 'largequery', 'LARGE-RECEIPT', 'LARGE-ANSWER'));
  assert.equal(large.memoryIds.length, 1, 'two whole 4096-byte items exceed the final injection cap');
  assert.deepEqual(data<ReceiptContext>(receiptContext(bridge, 'LARGE-RECEIPT', 'LARGE-ANSWER')).targets.map(x => x.memoryId), large.memoryIds);
});

test('receipt_context rejects duplicate bindings, excessive count, malformed and oversized receipt payloads', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge)); data(compose(bridge));
  const { binding } = storedFixture(f.path);
  const cases: Array<[string, string, string]> = [
    ['DUPLICATE', JSON.stringify([binding, binding]), 'receipt_duplicate_binding'],
    ['DUPLICATE-CHAIN', JSON.stringify([binding, { ...binding, memoryId: 'OTHER-MEMORY' }]), 'receipt_duplicate_binding'],
    ['TOO-MANY', JSON.stringify(Array(6).fill(binding)), 'receipt_target_capacity'],
    ['BAD-SHAPE', '{}', 'receipt_payload_invalid'],
    ['BAD-JSON', '{', 'receipt_payload_invalid'],
    ['OVERSIZED', ' '.repeat(BRIDGE_LIMITS.receiptPayloadBytes + 1), 'receipt_payload_capacity'],
    ['DUPLICATE-KEY', JSON.stringify([binding]).replace('"memoryId":', '"memoryId":"ignored","memoryId":'), 'receipt_payload_invalid'],
    ['BAD-VERSION', JSON.stringify([{ ...binding, memoryVersion: 0 }]), 'invalid_integer'],
    ['BAD-HASH', JSON.stringify([{ ...binding, contentHash: 'not-a-hash' }]), 'receipt_binding_invalid'],
    ['MISMATCH-HASH', JSON.stringify([{ ...binding, contentHash: '0'.repeat(64) }]), 'receipt_content_mismatch'],
  ];
  for (const [id, payload, code] of cases) {
    insertFixtureReceipt(f.path, id, payload);
    const reply = receiptContext(bridge, id); assert.equal(reply.status, 'rejected'); assert.equal(reply.code, code); assert.equal(reply.data, undefined);
  }
  const raw = '{"id":"R","operation":"receipt_context","args":{"receiptId":"RECEIPT-01","receiptId":"OTHER","sessionId":"current-session","parentTurnId":"ANSWER-01"}}';
  assert.equal(bridge.processLine(raw).code, 'invalid_json', 'duplicate request keys cannot silently replace trusted IDs');
});

test('receipt_context rejects version snapshot identity, physical scope, fingerprint and metadata corruption', t => {
  const f = fixture(t); const bridge = f.open(); data(seedScoped(bridge, 'project_memory')); data(compose(bridge));
  const original = storedFixture(f.path);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['ID', { record_id: 'OTHER' }, 'receipt_snapshot_mismatch'],
    ['VERSION', { version: 2 }, 'receipt_snapshot_mismatch'],
    ['TEAM', { team_id: 'foreign' }, 'receipt_snapshot_domain_mismatch'],
    ['USER', { user_id: 'foreign' }, 'receipt_snapshot_domain_mismatch'],
    ['AGENT', { agent_id: 'foreign' }, 'receipt_snapshot_domain_mismatch'],
    ['TASK', { task_id: 'foreign' }, 'receipt_snapshot_domain_mismatch'],
    ['CONTENT', { content: 'tampered content' }, 'receipt_content_mismatch'],
    ['TYPE', { type: 'persona' }, 'receipt_content_mismatch'],
    ['SCOPE', { metadata_json: '{"feedback_memory_scope":"current_turn"}' }, 'invalid_memory_scope'],
    ['META', { metadata_json: '{"feedback_memory_scope":"user_memory","feedback_memory_scope":"project_memory"}' }, 'receipt_metadata_invalid'],
    ['LONG-CONTENT', { content: 'x'.repeat(4097) }, 'invalid_text'],
  ];
  for (const [id, changes, code] of cases) {
    const chainId = 'BAD-CHAIN-' + id;
    insertFixtureVersion(f.path, chainId, JSON.stringify({ ...original.row, ...changes }), original.version.content_hash);
    insertFixtureReceipt(f.path, 'BAD-RECEIPT-' + id, JSON.stringify([{ ...original.binding, chainId }]));
    assert.equal(receiptContext(bridge, 'BAD-RECEIPT-' + id).code, code);
  }
  insertFixtureVersion(f.path, 'TOO-LONG-SNAPSHOT', ' '.repeat(DEFAULT_CHAIN_LIMITS.snapshotBytes + 1), original.version.content_hash);
  insertFixtureReceipt(f.path, 'LONG-SNAPSHOT', JSON.stringify([{ ...original.binding, chainId: 'TOO-LONG-SNAPSHOT' }]));
  assert.equal(receiptContext(bridge, 'LONG-SNAPSHOT').code, 'snapshot_capacity');
  insertFixtureReceipt(f.path, 'MISSING-VERSION', JSON.stringify([{ ...original.binding, chainVersion: 99 }]));
  assert.equal(receiptContext(bridge, 'MISSING-VERSION').code, 'receipt_version_mismatch');
});

test('receipt_context checks receipt TTL and future clocks independently of a restarted bridge deadline', t => {
  const f = fixture(t); const first = f.open(); data(seed(first)); data(compose(first)); first.close();
  f.advance(DEFAULT_CHAIN_LIMITS.receiptTtlMs); const atLimit = f.open(); data(receiptContext(atLimit)); atLimit.close();
  f.advance(1); const expired = f.open();
  assert.equal(receiptContext(expired).code, 'receipt_expired_or_clock_changed'); expired.close();
  const original = storedFixture(f.path);
  insertFixtureReceipt(f.path, 'FUTURE', original.receipt.payload_json, { created_ms: original.receipt.created_ms + DEFAULT_CHAIN_LIMITS.receiptTtlMs + 2 });
  const restarted = f.open(); assert.equal(receiptContext(restarted, 'FUTURE').code, 'receipt_expired_or_clock_changed');
});

test('receipt_context preserves the rendered historical snapshot after retirement, without reviving L1', t => {
  const f = fixture(t); const bridge = f.open(); data(seedScoped(bridge, 'user_memory')); data(compose(bridge));
  const before = data<ReceiptContext>(receiptContext(bridge));
  const message = '请忘掉这条长期数据库记录。'; data(capture(bridge, message));
  const { newContent: _omitted, ...args } = updateArgs(message);
  data(send(bridge, 'apply', { ...args, kind: 'retire' }));
  assert.deepEqual(data(receiptContext(bridge)), before, 'read-only context is historical evidence, not current memory state');
  const inspected = data<{ head: { state: string }; active: unknown }>(send(bridge, 'inspect', { memoryId: 'MEM-01' }));
  assert.equal(inspected.head.state, 'retired'); assert.equal(inspected.active, null);
  data(compose(bridge, 'database', 'POST-RETIRE', 'POST-RETIRE-ANSWER'));
  assert.deepEqual(data<ReceiptContext>(receiptContext(bridge, 'POST-RETIRE', 'POST-RETIRE-ANSWER')).targets, []);
});

test('CLI requires explicit isolated absolute database and complete locked scope', t => {
  const f = fixture(t);
  assert.throws(() => parseBridgeArgs(['--db', f.path, '--scope', JSON.stringify(scope)]), /isolated_flag_required/);
  assert.throws(() => parseBridgeArgs(['--isolated']), /explicit_database_and_scope_required/);
  assert.throws(() => parseBridgeArgs([...f.argv(), '--db', f.path]), /duplicate_cli_option/);
  assert.throws(() => parseBridgeArgs([...f.argv(), '--unknown', 'x']), /unknown_cli_option/);
  assert.throws(() => parseBridgeArgs([...f.argv(), '--deadline-ms', '3600001']), /invalid_integer/);
  assert.equal(parseBridgeArgs([...f.argv(), '--deadline-ms', '3600000']).deadlineMs, 3600000);
  assert.equal(parseBridgeArgs(f.argv()).deadlineMs, 120000);
  assert.throws(() => new IsolatedChainBridge({ isolated: true, dbPath: 'relative.sqlite', scope }), /absolute_isolated_database_required/);
  for (const badScope of [{ ...scope, taskId: undefined }, { ...scope, userId: 'default' }, { ...scope, taskId: 'DEFAULT' }]) {
    assert.throws(() => new IsolatedChainBridge({ isolated: true, dbPath: f.path, scope: badScope as typeof scope }), /invalid_identifier|explicit_scope_required/);
  }
  assert.equal(existsSync(f.path), false, 'invalid startup must not create a database');
});

test('unmarked existing database is refused read-only before any MemoryCore DDL or WAL switch', t => {
  const f = fixture(t); const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE unrelated_production_table(id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO unrelated_production_table VALUES(1,?)').run('preserve-this'); db.close();
  const bytes = readFileSync(f.path);
  assert.throws(() => f.open(), /isolated_database_marker_missing/);
  assert.deepEqual(readFileSync(f.path), bytes);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'feedback_%' OR name='l1_records'").get()?.n, 0);
    assert.equal(check.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  } finally { check.close(); }
});

test('seed, real FTS compose, trusted capture, apply and exact revision inspection round-trip', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge));
  const first = data<{ text: string; memoryIds: string[]; bindings: Array<{ memoryId: string; memoryVersion: number; chainVersion: number }> }>(compose(bridge));
  assert.match(first.text, /mysqllegacy/); assert.deepEqual(first.memoryIds, ['MEM-01']);
  assert.equal(first.bindings[0].memoryVersion, 1); assert.equal(first.bindings[0].chainVersion, 1);
  data(capture(bridge)); data(send(bridge, 'apply', updateArgs()));
  const second = data<{ text: string; bindings: Array<{ memoryVersion: number }> }>(compose(bridge, 'database', 'RECEIPT-02', 'ANSWER-02'));
  assert.match(second.text, /postgrescurrent/); assert.doesNotMatch(second.text, /mysqllegacy/);
  assert.equal(second.bindings[0].memoryVersion, 2);
  assert.equal(first.bindings[0].memoryVersion, 1, 'earlier final binding is not replaced by a mutable live version');
  const inspected = data<{ head: { chainVersion: number }; active: { content: string }; revision: { content: string } }>(send(bridge, 'inspect', { memoryId: 'MEM-01', chainVersion: 1 }));
  assert.equal(inspected.head.chainVersion, 2); assert.equal(inspected.active.content, 'database postgrescurrent');
  assert.equal(inspected.revision.content, 'database mysqllegacy');
  const oldSearch = data<{ text: string; memoryIds: string[] }>(compose(bridge, 'mysqllegacy', 'RECEIPT-03', 'ANSWER-03'));
  assert.equal(oldSearch.text, ''); assert.deepEqual(oldSearch.memoryIds, []);
});

test('compose uses real retrieval only: model supplied hits, scope, k or derived text are rejected', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge));
  const args = { query: 'database', receiptId: 'RECEIPT-01', sessionId: 'current-session', turnId: 'ANSWER-01' };
  for (const patch of [{ hits: [] }, { scope }, { domain: scope }, { k: 100 }, { derivedTexts: ['unsafe L3'] }]) {
    const result = send(bridge, 'compose', { ...args, ...patch });
    assert.equal(result.status, 'rejected'); assert.equal(result.code, 'unknown_field');
  }
  assert.equal(send(bridge, 'compose', { ...args, query: 'x'.repeat(4097) }).code, 'invalid_text');
  const result = data<{ retrievedCount: number; candidateK: number; finalK: number }>(compose(bridge));
  assert.equal(result.retrievedCount, 1); assert.equal(result.candidateK, 20); assert.equal(result.finalK, 5);
});

test('capture must precede mutation and cannot be forged through apply/domain changes', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge)); data(compose(bridge));
  assert.equal(send(bridge, 'apply', updateArgs()).code, 'source_capture_mismatch');
  data(capture(bridge));
  assert.equal(send(bridge, 'apply', { ...updateArgs(), domain: { ...scope, userId: 'other-user' } }).code, 'unknown_field');
  const forged = updateArgs('不是用户实际说过的话');
  assert.equal(send(bridge, 'apply', forged).code, 'source_capture_mismatch');
  assert.equal(send(bridge, 'apply', { ...updateArgs(), directUser: false }).code, 'explicit_memory_authority_required');
  data(send(bridge, 'apply', updateArgs()));
});

test('captured diagnostic and defer JSONL commands may stay unbound and leave real L1 unchanged', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge)); data(compose(bridge));
  data(capture(bridge));
  const before = data(send(bridge, 'inspect', { memoryId: 'MEM-01' }));
  const { newContent: _omitted, ...base } = updateArgs();
  for (const kind of ['diagnostic', 'defer']) {
    const result = bridge.processLine(JSON.stringify({ id: 'NOOP-' + kind, operation: 'apply',
      args: { ...base, eventId: 'EVENT-' + kind, kind, object: kind === 'diagnostic' ? 'answer' : 'unknown',
        targetId: '', expectedChainVersion: 0, expectedMemoryVersion: 0, directUser: true, durable: false } }));
    assert.deepEqual(data(result), { status: 'recorded', action: 'noop' }, 'unbound feedback must not invent a memory target');
    assert.deepEqual(data(send(bridge, 'inspect', { memoryId: 'MEM-01' })), before);
  }
  assert.equal(send(bridge, 'apply', { ...base, kind: 'retire', targetId: '',
    expectedChainVersion: 0, expectedMemoryVersion: 0 }).code, 'invalid_identifier');
  assert.equal(send(bridge, 'apply', { ...updateArgs(), expectedChainVersion: 0 }).code, 'invalid_integer');
  assert.deepEqual(data(send(bridge, 'inspect', { memoryId: 'MEM-01' })), before);
});

test('restart accepts only the original database scope and retains idempotent seed inputs', t => {
  const f = fixture(t); const first = f.open(); const initial = data(seed(first)); first.close();
  assert.throws(() => new IsolatedChainBridge({ isolated: true, dbPath: f.path,
    scope: { ...scope, taskId: 'another-task' } }), /database_scope_mismatch/);
  f.advance(1000); const second = f.open(); assert.deepEqual(data(seed(second)), initial);
  const state = data<{ head: { chainVersion: number } }>(send(second, 'inspect', { memoryId: 'MEM-01' }));
  assert.equal(state.head.chainVersion, 1);
});

test('inspect cannot execute arbitrary SQL or return an unbounded record', t => {
  const f = fixture(t); const bridge = f.open(); data(seed(bridge));
  assert.equal(send(bridge, 'inspect', { sql: 'SELECT * FROM l1_records' }).code, 'unknown_field');
  assert.equal(send(bridge, 'inspect', { memoryId: 'MEM-01', all: true }).code, 'unknown_field');
  const peer = new DatabaseSync(f.path);
  try { peer.prepare('UPDATE l1_records SET content=? WHERE record_id=?').run('x'.repeat(40000), 'MEM-01'); }
  finally { peer.close(); }
  const result = send(bridge, 'inspect', { memoryId: 'MEM-01' });
  assert.equal(result.status, 'rejected'); assert.equal(result.code, 'output_capacity');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < BRIDGE_LIMITS.outputBytes); assert.equal(result.data, undefined);
});

test('all frames consume the 256 request cap and closed bridges cannot mutate', t => {
  const f = fixture(t); const bridge = f.open();
  for (let i = 0; i < BRIDGE_LIMITS.requests; i++) {
    assert.equal(bridge.processLine('{bad json').code, 'invalid_json');
  }
  assert.equal(seed(bridge).code, 'request_capacity'); assert.equal(bridge.stopped, true);
  assert.equal(seed(bridge).code, 'bridge_closed');
  const peer = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(peer.prepare('SELECT count(*) AS n FROM l1_records').get()?.n, 0); } finally { peer.close(); }
});

test('deadline, oversized UTF-8 frames and invalid encoding fail with fixed safe codes', t => {
  const f = fixture(t); const bridge = f.open();
  assert.equal(bridge.processLine(Buffer.alloc(65537)).code, 'line_capacity');
  assert.equal(bridge.processLine(Buffer.from([0xff, 0xfe])).code, 'invalid_json');
  assert.equal(bridge.processLine('{DO_NOT_ECHO_ME').code, 'invalid_json');
  f.advance(BRIDGE_LIMITS.defaultDeadlineMs);
  const result = seed(bridge); assert.equal(result.code, 'deadline_exceeded'); assert.equal(result.status, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO_ME/);
});

test('CLI framer discards oversized lines then recovers; stdout contains JSON responses only', async t => {
  const f = fixture(t); const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, done) { lines.push(chunk.toString()); done(); } });
  const input = Readable.from([
    Buffer.from('x'.repeat(40000)), Buffer.from('x'.repeat(30000) + '\n'),
    Buffer.from('{PRIVATE_BAD_INPUT\n'),
    Buffer.from(JSON.stringify({ id: 'INSPECT-01', operation: 'inspect', args: { memoryId: 'MISSING' } }) + '\n'),
    Buffer.from(JSON.stringify({ id: 'STOP-01', operation: 'shutdown', args: {} }) + '\n'),
  ]);
  assert.equal(await runBridgeCli(f.argv(), input, output), 0);
  const results = lines.join('').trim().split('\n').map(line => JSON.parse(line) as BridgeResponse);
  assert.deepEqual(results.map(result => result.code), ['line_capacity', 'invalid_json', 'ok', 'ok']);
  assert.equal(results[2].id, 'INSPECT-01'); assert.equal(results[3].operation, 'shutdown');
  assert.doesNotMatch(lines.join(''), /PRIVATE_BAD_INPUT/);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= BRIDGE_LIMITS.outputBytes);
});
