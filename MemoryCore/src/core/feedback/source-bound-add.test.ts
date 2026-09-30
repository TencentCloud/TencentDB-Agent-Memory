/** E2-M1 new-path tests only. Real MemoryCore SQLite/FTS; no model or network. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { VectorStore, buildFtsQuery } from '../store/sqlite/memory-store.js';
import { SqliteAtomicMemoryPort } from './sqlite-atomic-port.js';
import { SqliteEvidenceChain, type Domain, type SourceAddCommand, type FeedbackCommand } from './sqlite-evidence-chain.js';
import { IsolatedChainBridge, type BridgeResponse } from './chain-stdio-bridge.js';

const domain: Domain = { teamId: 'source-team', userId: 'source-user', agentId: 'source-agent', taskId: 'source-task' };
type TestScope = { after: (fn: () => void) => void };
function fixture(t: TestScope, options: { mode?: 'off' | 'isolated'; limits?: Record<string, number> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2-m1-source-add-'));
  const path = join(dir, 'source.sqlite'); const store = new VectorStore(path, 0, { debug() {}, info() {}, warn() {}, error() {} });
  store.init(); assert.equal(store.isDegraded(), false); assert.equal(store.isFtsAvailable(), true);
  const port = new SqliteAtomicMemoryPort(store); const db = store.getRawDb(); let now = Date.parse('2026-09-05T00:00:00Z');
  const chain = new SqliteEvidenceChain(port, db, { mode: 'isolated', ...options, now: () => now });
  t.after(() => { store.close(); const owned = resolve(dir); assert.ok(owned.startsWith(resolve(tmpdir()) + sep)); rmSync(owned, { recursive: true, force: true }); });
  return { chain, port, db, store, advance(ms: number) { now += ms; } };
}
function proposal(turn = 1, content = 'database mysqllegacy'): SourceAddCommand {
  const raw = `请长期记住：${content}。`;
  const start = Array.from(raw.slice(0, raw.indexOf(content))).length;
  return { eventId: `EVENT-${turn}`, captureId: `SOURCE-${turn}`, chainId: `CHAIN-${turn}`, memoryId: `MEM-${turn}`, domain,
    memoryScope: 'project_memory', object: 'memory_content', directUser: true, durable: true,
    source: { role: 'user', sessionId: 'SESSION', turnId: `U-${turn}`, text: raw, start: 0, end: Array.from(raw).length, quote: raw },
    contentStart: start, contentEnd: start + Array.from(content).length, contentQuote: content };
}
function capture(chain: SqliteEvidenceChain, command = proposal(), parentReceiptId: string | null = null) {
  chain.captureSource({ captureId: command.captureId, domain: command.domain, sessionId: command.source.sessionId,
    turnId: command.source.turnId, parentReceiptId, text: command.source.text });
}
function receipt(f: ReturnType<typeof fixture>, turn: number) {
  return f.chain.composeInjection({ receiptId: `R-${turn}`, domain, sessionId: 'SESSION', turnId: `A-${turn}`,
    hits: f.store.searchL1Fts(buildFtsQuery('database')!, 5, domain), baselineText: '' });
}
function rejectCode(fn: () => unknown, code: string) { assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code); }

test('off source capture and ADD leave schema and baseline behavior unchanged', t => {
  const f = fixture(t, { mode: 'off' }); capture(f.chain);
  assert.deepEqual(f.chain.addFromSource(proposal()), { status: 'delegate_baseline', action: 'unchanged' });
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'feedback_%'").get(), undefined);
  assert.equal(f.port.getExact(domain, 'MEM-1'), null);
});
test('first observed user creates actual memory, FTS, source revision and add event without seed or receipt', t => {
  const f = fixture(t); const p = proposal(); capture(f.chain, p);
  assert.equal(f.chain.addFromSource(p).action, 'add');
  assert.equal(f.port.getExact(domain, 'MEM-1')?.content, p.contentQuote);
  assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain)[0].record_id, 'MEM-1');
  assert.equal(f.db.prepare('SELECT kind FROM feedback_events').get()!.kind, 'add_from_source');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback_receipts').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT purpose FROM feedback_source_uses').get()!.purpose, 'mutation');
  const span = JSON.parse(f.db.prepare('SELECT source_span_json FROM feedback_versions').get()!.source_span_json as string);
  assert.equal(span.content_start, p.contentStart); assert.equal(span.turn_id, 'U-1');
  assert.equal(JSON.stringify(span).includes(p.source.text), false);
});
test('ADD requires prior capture and rejects altered raw source or cross-domain proposal', t => {
  const f = fixture(t); rejectCode(() => f.chain.addFromSource(proposal()), 'source_capture_missing');
  capture(f.chain);
  const altered = proposal(1, 'database changed');
  rejectCode(() => f.chain.addFromSource(altered), 'source_capture_mismatch');
  rejectCode(() => f.chain.addFromSource({ ...proposal(), domain: { ...domain, userId: 'another-user' } }), 'source_capture_mismatch');
  assert.equal(f.port.getExact(domain, 'MEM-1'), null);
});
test('source capture is immutable and one captured source is accepted per parent', t => {
  const f = fixture(t); capture(f.chain); capture(f.chain);
  rejectCode(() => capture(f.chain, proposal(1, 'changed')), 'capture_id_payload_conflict');
  rejectCode(() => capture(f.chain, proposal(2)), 'source_capture_already_registered');
});
test('source spans use Unicode code points; ambiguous or invented contents are rejected', t => {
  const f = fixture(t); const p = proposal(1, 'database 🐼 使用中文'); capture(f.chain, p);
  rejectCode(() => f.chain.addFromSource({ ...p, contentEnd: p.contentEnd + 1 }), 'add_content_source_mismatch');
  rejectCode(() => f.chain.addFromSource({ ...p, contentQuote: 'invented content' }), 'add_content_source_mismatch');
  rejectCode(() => f.chain.addFromSource({ ...p, source: { ...p.source, end: p.source.end - 1 } }), 'source_span_mismatch');
  assert.equal(f.chain.addFromSource(p).status, 'applied');
});
test('ADD refuses duplicate source quote and content outside the feedback span', t => {
  const f = fixture(t); const p = proposal(1, 'database database'); capture(f.chain, p);
  rejectCode(() => f.chain.addFromSource({ ...p, contentQuote: 'database', contentEnd: p.contentStart + 8 }), 'add_content_source_mismatch');
  rejectCode(() => f.chain.addFromSource({ ...p, source: { ...p.source, end: 2, quote: '请长' } }), 'add_content_source_mismatch');
});
test('ADD requires explicit direct durable memory scope and object', t => {
  const f = fixture(t); capture(f.chain); const p = proposal();
  for (const patch of [{ directUser: false }, { durable: false }, { object: 'answer' }, { memoryScope: 'none' }])
    rejectCode(() => f.chain.addFromSource({ ...p, ...patch } as SourceAddCommand), 'explicit_add_authority_required');
});
test('ADD event replay remains idempotent after another receipt and expiry; changed ID payload rejects', t => {
  const f = fixture(t, { limits: { receiptTtlMs: 50 } }); const p = proposal(); capture(f.chain, p);
  const result = f.chain.addFromSource(p); receipt(f, 1); f.advance(51);
  assert.deepEqual(f.chain.addFromSource(p), result);
  rejectCode(() => f.chain.addFromSource({ ...p, memoryId: 'OTHER' }), 'event_id_payload_conflict');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM l1_records').get()!.n, 1);
});
test('fresh new ADD refuses expired capture and backward clock', t => {
  const f = fixture(t, { limits: { receiptTtlMs: 50 } }); capture(f.chain); f.advance(51);
  rejectCode(() => f.chain.addFromSource(proposal()), 'source_capture_expired_or_clock_changed');
  f.advance(-52); rejectCode(() => f.chain.addFromSource(proposal()), 'source_capture_expired_or_clock_changed');
});
test('only the latest real render can parent a subsequent capture and ADD', t => {
  const f = fixture(t); capture(f.chain); f.chain.addFromSource(proposal()); receipt(f, 1);
  rejectCode(() => capture(f.chain, proposal(2), null), 'source_parent_not_latest_render');
  capture(f.chain, proposal(2), 'R-1'); receipt(f, 2);
  rejectCode(() => f.chain.addFromSource(proposal(2)), 'source_parent_not_latest_render');
});
test('one source permits only one mutation, including different ADD event IDs', t => {
  const f = fixture(t); const p = proposal(); capture(f.chain, p); f.chain.addFromSource(p);
  rejectCode(() => f.chain.addFromSource({ ...p, eventId: 'OTHER', memoryId: 'MEM-2', chainId: 'CHAIN-2' }), 'source_turn_already_used');
});
test('duplicate chain and memory IDs cannot create a new entry', t => {
  const f = fixture(t); capture(f.chain); f.chain.addFromSource(proposal()); receipt(f, 1); const p = proposal(2); capture(f.chain, p, 'R-1');
  rejectCode(() => f.chain.addFromSource({ ...p, memoryId: 'MEM-1' }), 'chain_or_memory_already_managed');
  rejectCode(() => f.chain.addFromSource({ ...p, chainId: 'CHAIN-1' }), 'chain_or_memory_already_managed');
});
test('sixth active ADD rejects; captures and retained heads have independent finite caps', t => {
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) { const p = proposal(i, `database value${i}`); capture(f.chain, p, i === 1 ? null : `R-${i - 1}`); f.chain.addFromSource(p); receipt(f, i); }
  capture(f.chain, proposal(6), 'R-5'); rejectCode(() => f.chain.addFromSource(proposal(6)), 'active_memory_capacity');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM l1_records').get()!.n, 5);
  const g = fixture(t, { limits: { receipts: 1 } }); capture(g.chain); g.chain.addFromSource(proposal()); receipt(g, 1);
  rejectCode(() => capture(g.chain, proposal(2), 'R-1'), 'source_capture_capacity');
});
test('ADD transaction failure rolls back L1, FTS, head, version, source use and event together', t => {
  const f = fixture(t); capture(f.chain);
  f.db.exec("CREATE TRIGGER fail_add_event BEFORE INSERT ON feedback_events WHEN NEW.kind='add_from_source' BEGIN SELECT RAISE(ABORT,'fixture_failure'); END");
  assert.throws(() => f.chain.addFromSource(proposal()));
  for (const table of ['l1_records', 'l1_fts', 'feedback_heads', 'feedback_versions', 'feedback_source_uses', 'feedback_events'])
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0, table);
  f.db.exec('DROP TRIGGER fail_add_event'); assert.equal(f.chain.addFromSource(proposal()).status, 'applied');
});
test('new ADD is managed by existing delivered update/retire and cannot be mutated twice from one source', t => {
  const f = fixture(t); capture(f.chain); f.chain.addFromSource(proposal()); receipt(f, 1);
  const text = '长期数据库改为 database postgrescurrent。';
  const command: FeedbackCommand = { eventId: 'UPDATE', captureId: 'OLD-CAP-2', domain, receiptId: 'R-1', parentTurnId: 'A-1',
    targetId: 'MEM-1', expectedChainVersion: 1, expectedMemoryVersion: 1, kind: 'update', object: 'memory_content', directUser: true,
    durable: true, newContent: 'database postgrescurrent', source: { role: 'user', sessionId: 'SESSION', turnId: 'U-2', text,
      start: 0, end: Array.from(text).length, quote: text } };
  f.chain.captureUserTurn({ captureId: command.captureId, domain, sessionId: 'SESSION', turnId: 'U-2', parentReceiptId: 'R-1', text });
  const start = Array.from(text.slice(0, text.indexOf('database'))).length;
  const add: SourceAddCommand = { ...proposal(2), source: command.source, contentStart: start,
    contentEnd: start + 'database postgrescurrent'.length, contentQuote: 'database postgrescurrent' };
  capture(f.chain, add, 'R-1'); f.chain.apply(command);
  rejectCode(() => f.chain.addFromSource(add), 'source_turn_already_used');
  assert.equal(f.store.searchL1Fts(buildFtsQuery('mysqllegacy')!, 5, domain).length, 0);
  assert.match(receipt(f, 2).text, /postgrescurrent/);
  f.chain.captureUserTurn({ captureId: 'DELETE-CAP', domain, sessionId: 'SESSION', turnId: 'U-3', parentReceiptId: 'R-2', text });
  f.chain.apply({ ...command, eventId: 'DELETE', captureId: 'DELETE-CAP', kind: 'retire', receiptId: 'R-2', parentTurnId: 'A-2',
    expectedChainVersion: 2, expectedMemoryVersion: 2, source: { ...command.source, turnId: 'U-3' } });
  assert.equal(f.port.getExact(domain, 'MEM-1'), null); assert.equal(receipt(f, 3).text, '');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback_versions').get()!.n, 3);
});

function bridgeFixture(t: TestScope) {
  const dir = mkdtempSync(join(tmpdir(), 'e2-m1-source-bridge-')); const dbPath = join(dir, 'bridge.sqlite');
  const bridge = new IsolatedChainBridge({ isolated: true, dbPath, scope: domain }); let sequence = 0;
  t.after(() => { bridge.close(); const owned = resolve(dir); assert.ok(owned.startsWith(resolve(tmpdir()) + sep)); rmSync(owned, { recursive: true, force: true }); });
  return { bridge, send(operation: string, args: unknown): BridgeResponse { return bridge.processLine(JSON.stringify({ id: 'RPC-' + (++sequence), operation, args })); } };
}
function data(response: BridgeResponse): any { assert.equal(response.status, 'pass', JSON.stringify(response)); return response.data; }
test('bridge source ADD and snapshot expose actual state, bounded retrieval and readonly repeatability', t => {
  const f = bridgeFixture(t); const p = proposal(); assert.deepEqual(data(f.send('snapshot', {})).entries, []);
  data(f.send('capture_source', { captureId: p.captureId, sessionId: 'SESSION', turnId: 'U-1', parentReceiptId: null, text: p.source.text }));
  const { domain: _, ...args } = p; data(f.send('add_from_source', args));
  const first = data(f.send('snapshot', {})); assert.equal(first.activeCount, 1); assert.equal(first.entries[0].content, p.contentQuote);
  assert.equal(first.entries[0].versions[0].sourceSpan.turn_id, 'U-1'); assert.deepEqual(data(f.send('snapshot', {})), first);
  const result = f.send('compose', { query: 'database', receiptId: 'R-1', sessionId: 'SESSION', turnId: 'A-1', candidateK: 5, includeCandidates: true });
  assert.equal(result.cost.retrieval_k, 5); assert.equal(data(result).candidateK, 5); assert.match(data(result).text, /mysqllegacy/);
  assert.deepEqual(data(result).candidates, [{ memoryId: 'MEM-1', memoryVersion: 1, content: p.contentQuote }]);
  assert.deepEqual(data(f.send('snapshot', {})), first, 'snapshot/receipt do not modify stored heads or revisions');
});
test('bridge rejects caller domain, unknown fields, absent source and forged input shape', t => {
  const f = bridgeFixture(t); const p = proposal(); const { domain: _, ...args } = p;
  assert.equal(f.send('add_from_source', p).code, 'unknown_field');
  assert.equal(f.send('add_from_source', args).code, 'source_capture_missing');
  assert.equal(f.send('snapshot', { sql: 'anything' }).code, 'unknown_field');
  assert.equal(f.send('capture_source', { captureId: 'X', sessionId: 'SESSION', turnId: 'U-1', parentReceiptId: false, text: 'raw' }).code, 'invalid_identifier');
});
