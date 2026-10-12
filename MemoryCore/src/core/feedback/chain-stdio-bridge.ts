/** Trusted-host JSONL bridge for isolated MemoryCore fixtures, never a model tool.
 * No network, no .env, no default database, no production-path discovery.
 */
import { closeSync, existsSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Readable, Writable } from 'node:stream';
import { VectorStore as SqliteMemoryStore, buildFtsQuery } from '../store/sqlite/memory-store.js';
import type { L1RecordRow, MemoryRecord } from '../store/types.js';
import type { EpisodicMetadata } from '../record/l1-writer.js';
import { AtomicMemoryPortError, SqliteAtomicMemoryPort } from './sqlite-atomic-port.js';
import { ChainRejected, SqliteEvidenceChain, contentFingerprint, type Domain, type FeedbackCommand, type SourceAddCommand } from './sqlite-evidence-chain.js';

export const BRIDGE_LIMITS = Object.freeze({ lineBytes: 65536, outputBytes: 32768,
  requests: 256, queryBytes: 4096, candidateK: 20, k: 5, inputBytes: 8192,
  contentBytes: 4096, receiptPayloadBytes: 4096, jsonDepth: 8, jsonNodes: 512,
  operationMs: 5000, outputWriteMs: 1000, defaultDeadlineMs: 120000, maxDeadlineMs: 3600000 });
const OPS = ['seed', 'compose', 'receipt_context', 'capture', 'apply', 'inspect', 'shutdown', 'capture_source', 'add_from_source', 'snapshot'] as const;
type Operation = typeof OPS[number];
type ObjectValue = Record<string, unknown>;
type MemoryScope = 'user_memory' | 'project_memory' | 'task_experience';
export interface ReceiptContext {
  receiptId: string; sessionId: string; parentTurnId: string; domain: Domain;
  targets: Array<{ memoryId: string; chainVersion: number; memoryVersion: number;
    memory_scope: MemoryScope | null; content: string }>;
}
export interface BridgeResponse {
  id: string | null; operation: Operation | 'unknown'; status: 'pass' | 'rejected' | 'error';
  code: string; data?: unknown;
  cost: { latency_ms: number; provider_calls: 0; retrieval_k?: number; injected_bytes?: number };
}
class BridgeRejected extends AtomicMemoryPortError {
  constructor(code: string) { super(code); this.name = 'BridgeRejected'; }
}
function deny(code: string): never { throw new BridgeRejected(code); }
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny('invalid_object');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) deny('invalid_object');
  }
  return value as ObjectValue;
}
function keys(value: ObjectValue, required: string[], optional: string[] = []) {
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) deny('unknown_field');
  if (required.some(key => !Object.hasOwn(value, key))) deny('missing_field');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) deny('invalid_identifier');
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) deny('invalid_text');
  return value;
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) deny('invalid_integer');
  return value as number;
}
function checkedScope(value: unknown): Domain {
  const source = object(value); keys(source, ['teamId', 'userId', 'agentId', 'taskId']);
  for (const key of ['teamId', 'userId', 'agentId', 'taskId']) {
    if (key === 'taskId' && source[key] === '') continue;
    identifier(source[key]);
    if ((source[key] as string).toLowerCase() === 'default') deny('explicit_scope_required');
  }
  return Object.freeze({ teamId: source.teamId as string, userId: source.userId as string,
    agentId: source.agentId as string, taskId: source.taskId as string });
}
function scopeJson(scope: Domain): string { return JSON.stringify([scope.teamId, scope.userId, scope.agentId, scope.taskId]); }
function memoryScope(value: unknown): MemoryScope | null {
  if (value === undefined || value === null) return null;
  if (!['user_memory', 'project_memory', 'task_experience'].includes(value as string)) deny('invalid_memory_scope');
  return value as MemoryScope;
}

/** Bounded JSON scanner catches duplicate keys before JSON.parse discards them. */
function strictJson(source: string): unknown {
  let at = 0; let nodes = 0;
  const whitespace = () => { while (at < source.length && /[ \r\n\t]/.test(source[at])) at++; };
  const quoted = (): string => {
    if (source[at] !== '"') deny('invalid_json');
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    return deny('invalid_json');
  };
  const value = (depth: number): void => {
    if (++nodes > BRIDGE_LIMITS.jsonNodes || depth > BRIDGE_LIMITS.jsonDepth) deny('invalid_json');
    whitespace(); const token = source[at];
    if (token === '{') {
      at++; whitespace(); const seen = new Set<string>();
      if (source[at] === '}') { at++; return; }
      while (at < source.length) {
        whitespace(); const key = quoted();
        if (seen.has(key)) deny('invalid_json'); seen.add(key);
        whitespace(); if (source[at++] !== ':') deny('invalid_json'); value(depth + 1); whitespace();
        if (source[at] === '}') { at++; return; }
        if (source[at++] !== ',') deny('invalid_json');
      }
      deny('invalid_json');
    } else if (token === '[') {
      at++; whitespace(); if (source[at] === ']') { at++; return; }
      while (at < source.length) {
        value(depth + 1); whitespace(); if (source[at] === ']') { at++; return; }
        if (source[at++] !== ',') deny('invalid_json');
      }
      deny('invalid_json');
    } else if (token === '"') { quoted(); }
    else {
      const start = at;
      while (at < source.length && !/[\s,\]}]/.test(source[at])) at++;
      if (start === at) deny('invalid_json');
      const primitive: unknown = JSON.parse(source.slice(start, at));
      if (typeof primitive === 'number' && !Number.isFinite(primitive)) deny('invalid_json');
    }
  };
  value(0); whitespace(); if (at !== source.length) deny('invalid_json');
  return JSON.parse(source);
}
function storedJson(source: unknown, cap: number, capacityCode: string, invalidCode: string): unknown {
  if (typeof source !== 'string') deny(invalidCode);
  if (Buffer.byteLength(source) > cap) deny(capacityCode);
  try { return strictJson(source); } catch { return deny(invalidCode); }
}

export interface BridgeOptions { isolated: true; dbPath: string; scope: Domain; deadlineMs?: number; now?: () => number }
export class IsolatedChainBridge {
  private readonly store: SqliteMemoryStore;
  private readonly port: SqliteAtomicMemoryPort;
  private readonly chain: SqliteEvidenceChain;
  private readonly scope: Domain;
  private readonly now: () => number;
  private readonly deadlineAt: number;
  private readonly epochTime: string;
  private requests = 0;
  private closed = false;
  private storeWarningCount = 0;
  get stopped(): boolean { return this.closed; }

  constructor(options: BridgeOptions) {
    if (options.isolated !== true) deny('isolated_flag_required');
    this.scope = checkedScope(options.scope);
    this.now = options.now ?? Date.now;
    const duration = integer(options.deadlineMs ?? BRIDGE_LIMITS.defaultDeadlineMs, 1, BRIDGE_LIMITS.maxDeadlineMs);
    const started = integer(this.now(), 0); this.deadlineAt = started + duration;
    if (typeof options.dbPath !== 'string' || !isAbsolute(options.dbPath) || !['.sqlite', '.db'].includes(extname(options.dbPath).toLowerCase())) deny('absolute_isolated_database_required');
    const path = resolve(options.dbPath);
    if (!existsSync(dirname(path)) || !lstatSync(dirname(path)).isDirectory()) deny('database_parent_missing');
    if (realpathSync(dirname(path)) !== resolve(dirname(path))) deny('database_parent_symlink_rejected');
    let createdMs = started;
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) deny('database_file_required');
      // Read-only inspection occurs BEFORE VectorStore.init: opening an unrelated
      // production SQLite file must never create sidecar tables or change WAL.
      let probe: DatabaseSync | undefined;
      try {
        probe = new DatabaseSync(path, { readOnly: true });
        const marker = probe.prepare('SELECT schema_version,mode,scope_json,created_ms FROM memory_chain_bridge_identity WHERE singleton=1').get() as
          { schema_version: number; mode: string; scope_json: string; created_ms: number } | undefined;
        if (!marker || marker.schema_version !== 1 || marker.mode !== 'isolated') deny('isolated_database_marker_missing');
        if (marker.scope_json !== scopeJson(this.scope)) deny('database_scope_mismatch');
        createdMs = integer(marker.created_ms, 0);
      } catch (error) {
        if (error instanceof BridgeRejected) throw error;
        deny('isolated_database_marker_missing');
      } finally { probe?.close(); }
    } else {
      // Exclusive creation prevents an exists/open race from adopting a file
      // created by another process. A failed initialization remains unmarked.
      try { closeSync(openSync(path, 'wx', 0o600)); } catch { deny('database_creation_failed'); }
    }
    // The upstream FTS helper converts errors to []; count warnings without
    // retaining their text so this bridge can distinguish errors from no hits.
    const silentLogger = { debug() {}, info() {},
      warn: () => { this.storeWarningCount++; }, error: () => { this.storeWarningCount++; } };
    const store = new SqliteMemoryStore(path, 0, silentLogger);
    try {
      store.init();
      if (store.isDegraded() || !store.isFtsAvailable()) deny('real_sqlite_fts_required');
      this.port = new SqliteAtomicMemoryPort(store);
      const db = store.getRawDb(); db.exec('PRAGMA busy_timeout=2000');
      this.chain = new SqliteEvidenceChain(this.port, db, { mode: 'isolated', now: this.now });
      this.port.atomic(() => {
        db.exec('CREATE TABLE IF NOT EXISTS memory_chain_bridge_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,mode TEXT NOT NULL,scope_json TEXT NOT NULL,created_ms INTEGER NOT NULL)');
        db.prepare('INSERT OR IGNORE INTO memory_chain_bridge_identity VALUES(1,1,?,?,?)').run('isolated', scopeJson(this.scope), createdMs);
      });
      this.store = store; this.epochTime = new Date(createdMs).toISOString();
    } catch (error) { store.close(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.store.close(); } }

  /** Every frame, including invalid JSON/oversize frames, spends one request slot. */
  processLine(line: string | Buffer): BridgeResponse {
    const started = performance.now();
    const base: BridgeResponse = { id: null, operation: 'unknown', status: 'rejected', code: 'invalid_json',
      cost: { latency_ms: 0, provider_calls: 0 } };
    try {
      if (this.closed) deny('bridge_closed');
      if (++this.requests > BRIDGE_LIMITS.requests) { this.close(); deny('request_capacity'); }
      if (this.now() >= this.deadlineAt) { this.close(); deny('deadline_exceeded'); }
      if (Buffer.byteLength(line) > BRIDGE_LIMITS.lineBytes) deny('line_capacity');
      let request: ObjectValue;
      try {
        const decoded = typeof line === 'string' ? line : new TextDecoder('utf-8', { fatal: true }).decode(line);
        request = object(strictJson(decoded));
      } catch { deny('invalid_json'); }
      keys(request!, ['id', 'operation', 'args']);
      base.id = identifier(request!.id);
      if (!OPS.includes(request!.operation as Operation)) deny('operation_not_allowed');
      base.operation = request!.operation as Operation;
      const args = object(request!.args);
      if (base.operation === 'shutdown') {
        keys(args, []); this.close(); return { ...base, status: 'pass', code: 'ok', data: { shutdown: true },
          cost: { latency_ms: Math.round(performance.now() - started), provider_calls: 0 } };
      }
      const operationDeadline = Math.min(this.deadlineAt, this.now() + BRIDGE_LIMITS.operationMs);
      const data = this.port.atomic(() => {
        if (this.now() >= operationDeadline) deny('deadline_exceeded');
        const result = this.execute(base.operation as Exclude<Operation, 'shutdown'>, args);
        // Reject oversized replies / missed deadlines BEFORE transaction commit.
        if (Buffer.byteLength(JSON.stringify({ ...base, data: result })) > BRIDGE_LIMITS.outputBytes - 256) deny('output_capacity');
        if (this.now() >= operationDeadline) deny('deadline_exceeded');
        return result;
      });
      base.status = 'pass'; base.code = 'ok'; base.data = data;
      if (base.operation === 'compose') {
        base.cost.retrieval_k = (data as { candidateK: number }).candidateK;
        base.cost.injected_bytes = Buffer.byteLength((data as { text: string }).text);
      }
    } catch (error) {
      if (error instanceof ChainRejected || error instanceof BridgeRejected) { base.status = 'rejected'; base.code = error.code; }
      else if (error instanceof AtomicMemoryPortError) { base.status = 'error'; base.code = error.code; }
      else { base.status = 'error'; base.code = 'bridge_operation_failed'; }
    }
    base.cost.latency_ms = Math.round(performance.now() - started);
    return base;
  }

  private execute(operation: Exclude<Operation, 'shutdown'>, args: ObjectValue): unknown {
    const db = this.port.getRawDb();
    if (operation === 'snapshot') {
      keys(args, []);
      return this.stateSnapshot();
    }
    if (operation === 'capture_source') {
      keys(args, ['captureId', 'sessionId', 'turnId', 'parentReceiptId', 'text']);
      for (const key of ['captureId', 'sessionId', 'turnId']) identifier(args[key]);
      if (args.parentReceiptId !== null) identifier(args.parentReceiptId);
      this.chain.captureSource({ captureId: args.captureId as string, domain: this.scope,
        sessionId: args.sessionId as string, turnId: args.turnId as string,
        parentReceiptId: args.parentReceiptId as string | null, text: text(args.text, BRIDGE_LIMITS.inputBytes) });
      return { captureId: args.captureId, recorded: true };
    }
    if (operation === 'add_from_source') {
      keys(args, ['eventId', 'captureId', 'chainId', 'memoryId', 'memoryScope', 'object', 'directUser', 'durable',
        'source', 'contentStart', 'contentEnd', 'contentQuote']);
      for (const key of ['eventId', 'captureId', 'chainId', 'memoryId']) identifier(args[key]);
      if (memoryScope(args.memoryScope) === null) deny('explicit_memory_scope_required');
      const source = object(args.source); keys(source, ['role', 'sessionId', 'turnId', 'text', 'start', 'end', 'quote']);
      identifier(source.sessionId); identifier(source.turnId); text(source.text, BRIDGE_LIMITS.inputBytes);
      text(source.quote, BRIDGE_LIMITS.inputBytes); integer(source.start, 0); integer(source.end);
      integer(args.contentStart, 0); integer(args.contentEnd); text(args.contentQuote, BRIDGE_LIMITS.contentBytes);
      return this.chain.addFromSource({ ...args, domain: this.scope } as unknown as SourceAddCommand);
    }
    if (operation === 'seed') {
      keys(args, ['eventId', 'chainId', 'memoryId', 'content', 'sessionId', 'turnId'], ['type', 'createdAt', 'memoryScope']);
      for (const key of ['eventId', 'chainId', 'memoryId', 'sessionId', 'turnId']) identifier(args[key]);
      const type = args.type ?? 'instruction';
      if (!['persona', 'episodic', 'instruction', 'work_fact', 'work_task', 'work_method', 'work_artifact'].includes(type as string)) deny('invalid_memory_type');
      const timestamp = args.createdAt ?? this.epochTime;
      if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || Buffer.byteLength(timestamp) > 64) deny('invalid_timestamp');
      const semanticScope = memoryScope(args.memoryScope);
      const metadata: EpisodicMetadata & { source: 'isolated_stdio_bridge'; feedback_memory_scope?: MemoryScope } = {
        source: 'isolated_stdio_bridge',
        ...(semanticScope === null ? {} : { feedback_memory_scope: semanticScope }),
      };
      const record: MemoryRecord = { id: args.memoryId as string, content: text(args.content, BRIDGE_LIMITS.contentBytes),
        type: type as MemoryRecord['type'], version: 1, priority: 50, scene_name: '',
        source_message_ids: [args.turnId as string], metadata,
        timestamps: [timestamp], createdAt: timestamp, updatedAt: timestamp,
        sessionKey: args.sessionId as string, sessionId: args.sessionId as string, ...this.scope };
      return this.chain.seed(args.eventId as string, args.chainId as string, this.scope, record);
    }
    if (operation === 'compose') {
      keys(args, ['query', 'receiptId', 'sessionId', 'turnId'], ['candidateK', 'includeCandidates']);
      if (args.includeCandidates !== undefined && typeof args.includeCandidates !== 'boolean') deny('invalid_candidate_evidence_flag');
      for (const key of ['receiptId', 'sessionId', 'turnId']) identifier(args[key]);
      const candidateK = args.candidateK === undefined ? BRIDGE_LIMITS.candidateK : integer(args.candidateK, 1, BRIDGE_LIMITS.candidateK);
      const query = buildFtsQuery(text(args.query, BRIDGE_LIMITS.queryBytes));
      if (!query) deny('query_has_no_search_terms');
      const warningsBefore = this.storeWarningCount;
      const hits = this.store.searchL1Fts(query, candidateK, this.scope);
      if (this.storeWarningCount !== warningsBefore) throw new AtomicMemoryPortError('fts_search_failed');
      const result = this.chain.composeInjection({ receiptId: args.receiptId as string, domain: this.scope,
        sessionId: args.sessionId as string, turnId: args.turnId as string, hits, baselineText: '' });
      const receipt = db.prepare('SELECT payload_json FROM feedback_receipts WHERE receipt_id=? AND domain_json=?').get(
        result.receiptId, scopeJson(this.scope)) as { payload_json: string } | undefined;
      if (!receipt) deny('receipt_readback_failed');
      // Version bindings come from the immutable FINAL receipt, not a later live read.
      return { ...result, bindings: JSON.parse(receipt.payload_json), retrievedCount: hits.length,
        candidateK, finalK: BRIDGE_LIMITS.k,
        ...(args.includeCandidates === true ? { candidates: hits.map(hit => ({ memoryId: hit.record_id,
          memoryVersion: hit.version, content: text(hit.content, BRIDGE_LIMITS.contentBytes) })) } : {}) };
    }
    if (operation === 'capture') {
      keys(args, ['captureId', 'sessionId', 'turnId', 'parentReceiptId', 'text']);
      for (const key of ['captureId', 'sessionId', 'turnId', 'parentReceiptId']) identifier(args[key]);
      this.chain.captureUserTurn({ captureId: args.captureId as string, domain: this.scope,
        sessionId: args.sessionId as string, turnId: args.turnId as string,
        parentReceiptId: args.parentReceiptId as string, text: text(args.text, BRIDGE_LIMITS.inputBytes) });
      return { captureId: args.captureId, recorded: true };
    }
    if (operation === 'receipt_context') return this.receiptContext(args);
    if (operation === 'apply') {
      keys(args, ['eventId', 'captureId', 'receiptId', 'parentTurnId', 'targetId', 'expectedChainVersion',
        'expectedMemoryVersion', 'kind', 'object', 'directUser', 'durable', 'source'], ['newContent']);
      for (const key of ['eventId', 'captureId', 'receiptId', 'parentTurnId']) identifier(args[key]);
      const unboundNoop = args.kind === 'defer' || args.kind === 'diagnostic';
      if (!unboundNoop || args.targetId !== '') identifier(args.targetId);
      integer(args.expectedChainVersion, unboundNoop ? 0 : 1);
      integer(args.expectedMemoryVersion, unboundNoop ? 0 : 1);
      const source = object(args.source); keys(source, ['role', 'sessionId', 'turnId', 'text', 'start', 'end', 'quote']);
      identifier(source.sessionId); identifier(source.turnId); text(source.text, BRIDGE_LIMITS.inputBytes);
      text(source.quote, BRIDGE_LIMITS.inputBytes); integer(source.start, 0); integer(source.end);
      if (Object.hasOwn(args, 'newContent')) text(args.newContent, BRIDGE_LIMITS.contentBytes);
      return this.chain.apply({ ...args, domain: this.scope } as unknown as FeedbackCommand);
    }
    keys(args, ['memoryId'], ['chainVersion']); identifier(args.memoryId);
    if (args.chainVersion !== undefined) integer(args.chainVersion);
    const memoryId = args.memoryId as string;
    const head = db.prepare('SELECT chain_id,chain_version,memory_version,state,evidence_count FROM feedback_heads WHERE memory_id=? AND domain_json=? LIMIT 1').get(memoryId, scopeJson(this.scope)) as
      { chain_id: string; chain_version: number; memory_version: number; state: string; evidence_count: number } | undefined;
    const active = this.port.getExact(this.scope, memoryId);
    const version = head ? db.prepare('SELECT chain_version,previous_version,state,record_snapshot FROM feedback_versions WHERE chain_id=? AND chain_version=? LIMIT 1').get(
      head.chain_id, (args.chainVersion as number | undefined) ?? head.chain_version) as
      { chain_version: number; previous_version: number | null; state: string; record_snapshot: string } | undefined : undefined;
    let revision: unknown = null;
    if (version) {
      if (Buffer.byteLength(version.record_snapshot) > 16384) deny('snapshot_capacity');
      const row = JSON.parse(version.record_snapshot) as { record_id: string; version: number; content: string } | null;
      revision = { chainVersion: version.chain_version, previousVersion: version.previous_version, state: version.state,
        memoryId: row?.record_id ?? memoryId, memoryVersion: row?.version ?? null, content: row?.content ?? null };
    }
    return { memoryId,
      head: head ? { chainId: head.chain_id, chainVersion: head.chain_version, memoryVersion: head.memory_version,
        state: head.state, evidenceCount: head.evidence_count } : null,
      active: active ? { memoryId: active.record_id, memoryVersion: active.version, type: active.type, content: active.content } : null,
      revision };
  }

  /** Current real state, including retirement heads and bounded revision
   * metadata. Does not seed, compose receipts, repair indexes or truncate rows.
   * All heads count toward the retained 256-chain cap; the 32-KiB reply guard
   * rejects oversized histories before returning a misleading partial state. */
  private stateSnapshot(): unknown {
    const db = this.port.getRawDb();
    const heads = db.prepare(`SELECT chain_id,chain_version,memory_id,memory_version,state,evidence_count,content_hash
      FROM feedback_heads WHERE domain_json=? ORDER BY chain_id LIMIT ?`).all(scopeJson(this.scope), this.chain.limits.chains + 1) as
      Array<{ chain_id: string; chain_version: number; memory_id: string; memory_version: number;
        state: string; evidence_count: number; content_hash: string }>;
    if (heads.length > this.chain.limits.chains) deny('snapshot_chain_capacity');
    const entries = heads.map(head => {
      const row = this.port.getExact(this.scope, head.memory_id);
      if (head.state !== 'active' && head.state !== 'retired') deny('snapshot_state_invalid');
      if (head.state === 'retired' && row) deny('snapshot_retired_memory_present');
      if (head.state === 'active' && (!row || row.version !== head.memory_version || contentFingerprint(row) !== head.content_hash))
        deny('snapshot_external_change');
      let semanticScope: MemoryScope | null = null;
      if (row) {
        const metadata = object(storedJson(row.metadata_json, this.chain.limits.snapshotBytes, 'snapshot_capacity', 'snapshot_metadata_invalid'));
        semanticScope = memoryScope(metadata.feedback_memory_scope);
        text(row.content, BRIDGE_LIMITS.contentBytes);
      }
      const revisions = db.prepare(`SELECT chain_version,previous_version,state,source_span_json FROM feedback_versions
        WHERE chain_id=? ORDER BY chain_version LIMIT ?`).all(head.chain_id, this.chain.limits.versionsPerChain + 2) as
        Array<{ chain_version: number; previous_version: number | null; state: string; source_span_json: string }>;
      if (revisions.length > this.chain.limits.versionsPerChain + 1 || revisions.length !== head.chain_version)
        deny('snapshot_version_capacity_or_gap');
      const versions = revisions.map(revision => ({ chainVersion: revision.chain_version,
        previousVersion: revision.previous_version, state: revision.state,
        sourceSpan: storedJson(revision.source_span_json, 2048, 'snapshot_source_capacity', 'snapshot_source_invalid') }));
      return { chainId: head.chain_id, memoryId: head.memory_id, chainVersion: head.chain_version,
        memoryVersion: head.memory_version, state: head.state, evidenceCount: head.evidence_count,
        memory_scope: semanticScope, content: row?.content ?? null, versions };
    });
    return { mode: 'isolated', entries, totalHeads: entries.length,
      activeCount: entries.filter(entry => entry.state === 'active').length,
      retiredCount: entries.filter(entry => entry.state === 'retired').length,
      revisionCount: entries.reduce((total, entry) => total + entry.versions.length, 0) };
  }

  /** Historical rendered context only: it never grants mutation authority.
   * At most five exact version lookups; no live content/metadata or table scan.
   */
  private receiptContext(args: ObjectValue): ReceiptContext {
    keys(args, ['receiptId', 'sessionId', 'parentTurnId']);
    for (const key of ['receiptId', 'sessionId', 'parentTurnId']) identifier(args[key]);
    const db = this.port.getRawDb();
    const receipt = db.prepare(`SELECT created_ms,length(CAST(payload_json AS BLOB)) AS payload_bytes,
      CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json ELSE NULL END AS payload_json
      FROM feedback_receipts WHERE receipt_id=? AND domain_json=? AND session_id=? AND turn_id=? LIMIT 1`).get(
      BRIDGE_LIMITS.receiptPayloadBytes, args.receiptId as string, scopeJson(this.scope),
      args.sessionId as string, args.parentTurnId as string) as
      { created_ms: number; payload_bytes: number; payload_json: string | null } | undefined;
    if (!receipt) deny('receipt_context_mismatch');
    const now = this.now(); const age = now - receipt.created_ms;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(receipt.created_ms) || receipt.created_ms < 0
        || !Number.isSafeInteger(age) || age < 0 || age > this.chain.limits.receiptTtlMs) deny('receipt_expired_or_clock_changed');
    if (receipt.payload_bytes > BRIDGE_LIMITS.receiptPayloadBytes) deny('receipt_payload_capacity');
    const bindings = storedJson(receipt.payload_json, BRIDGE_LIMITS.receiptPayloadBytes,
      'receipt_payload_capacity', 'receipt_payload_invalid');
    if (!Array.isArray(bindings)) deny('receipt_payload_invalid');
    if (bindings.length > Math.min(BRIDGE_LIMITS.k, this.chain.limits.k)) deny('receipt_target_capacity');
    const seenMemories = new Set<string>(); const seenChains = new Set<string>();
    const targets: ReceiptContext['targets'] = []; const rendered: string[] = [];
    for (const raw of bindings) {
      const binding = object(raw);
      keys(binding, ['chainId', 'chainVersion', 'memoryId', 'memoryVersion', 'contentHash']);
      const chainId = identifier(binding.chainId); const memoryId = identifier(binding.memoryId);
      const chainVersion = integer(binding.chainVersion); const memoryVersion = integer(binding.memoryVersion);
      if (typeof binding.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(binding.contentHash)) deny('receipt_binding_invalid');
      if (seenMemories.has(memoryId) || seenChains.has(chainId)) deny('receipt_duplicate_binding');
      seenMemories.add(memoryId); seenChains.add(chainId);
      const version = db.prepare(`SELECT chain_version,state,content_hash,
        length(CAST(record_snapshot AS BLOB)) AS snapshot_bytes,
        CASE WHEN length(CAST(record_snapshot AS BLOB))<=? THEN record_snapshot ELSE NULL END AS record_snapshot
        FROM feedback_versions WHERE chain_id=? AND chain_version=? LIMIT 1`).get(
        this.chain.limits.snapshotBytes, chainId, chainVersion) as
        { chain_version: number; state: string; content_hash: string; snapshot_bytes: number; record_snapshot: string | null } | undefined;
      if (!version || version.chain_version !== chainVersion || version.state !== 'active') deny('receipt_version_mismatch');
      if (version.snapshot_bytes > this.chain.limits.snapshotBytes) deny('snapshot_capacity');
      const row = object(storedJson(version.record_snapshot, this.chain.limits.snapshotBytes,
        'snapshot_capacity', 'receipt_snapshot_invalid'));
      if (row.record_id !== memoryId || row.version !== memoryVersion) deny('receipt_snapshot_mismatch');
      if (row.team_id !== this.scope.teamId || row.user_id !== this.scope.userId
          || row.agent_id !== this.scope.agentId || row.task_id !== this.scope.taskId) deny('receipt_snapshot_domain_mismatch');
      const content = text(row.content, BRIDGE_LIMITS.contentBytes);
      if (typeof row.type !== 'string' || !['persona', 'episodic', 'instruction', 'work_fact', 'work_task', 'work_method', 'work_artifact'].includes(row.type)) deny('receipt_snapshot_invalid');
      if (version.content_hash !== binding.contentHash || contentFingerprint(row as unknown as L1RecordRow) !== binding.contentHash) deny('receipt_content_mismatch');
      const metadata = object(storedJson(row.metadata_json, this.chain.limits.snapshotBytes,
        'snapshot_capacity', 'receipt_metadata_invalid'));
      const semanticScope = memoryScope(metadata.feedback_memory_scope);
      rendered.push('- [memory ' + memoryId + '@' + chainVersion + '] ' + JSON.stringify(content));
      if (Buffer.byteLength(rendered.join('\n')) > this.chain.limits.injectionBytes) deny('receipt_injection_capacity');
      targets.push({ memoryId, chainVersion, memoryVersion, memory_scope: semanticScope, content });
    }
    return { receiptId: args.receiptId as string, sessionId: args.sessionId as string,
      parentTurnId: args.parentTurnId as string, domain: this.scope, targets };
  }
}

export function parseBridgeArgs(argv: string[]): BridgeOptions {
  const options: ObjectValue = {}; let isolated = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--isolated') { if (isolated) deny('duplicate_cli_option'); isolated = true; continue; }
    if (!['--db', '--scope', '--deadline-ms'].includes(key)) deny('unknown_cli_option');
    if (Object.hasOwn(options, key)) deny('duplicate_cli_option');
    if (i + 1 >= argv.length) deny('missing_cli_value'); options[key] = argv[++i];
  }
  if (!isolated) deny('isolated_flag_required');
  if (typeof options['--db'] !== 'string' || typeof options['--scope'] !== 'string') deny('explicit_database_and_scope_required');
  let scope: Domain;
  try { scope = checkedScope(JSON.parse(options['--scope'] as string)); } catch { deny('invalid_scope'); }
  return { isolated: true, dbPath: options['--db'] as string, scope: scope!,
    deadlineMs: options['--deadline-ms'] === undefined ? BRIDGE_LIMITS.defaultDeadlineMs : integer(Number(options['--deadline-ms']), 1, BRIDGE_LIMITS.maxDeadlineMs) };
}

/** Bounded streaming framer: never accumulates more than 64 KiB per input line. */
export async function runBridgeCli(argv: string[], input: Readable = process.stdin, output: Writable = process.stdout): Promise<number> {
  let bridge: IsolatedChainBridge | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let terminalError: BridgeRejected | undefined; let outputFailed = false;
  let interruptWrite: ((error: BridgeRejected) => void) | undefined;
  const stop = (code: string, failedOutput = false) => {
    terminalError ??= new BridgeRejected(code);
    outputFailed ||= failedOutput;
    // Destroying input alone cannot interrupt a suspended output write. Do not
    // inject an input error here: the iterator may already have consumed EOF.
    interruptWrite?.(terminalError);
    input.destroy();
  };
  const onOutputError = () => stop('output_stream_failed', true);
  const onOutputClose = () => stop('output_closed', true);
  output.on('error', onOutputError); output.on('close', onOutputClose);
  const emit = async (response: BridgeResponse, errorReport = false) => {
    if (outputFailed || output.destroyed || output.writableEnded) deny('output_closed');
    if (terminalError && !errorReport) throw terminalError;
    const line = JSON.stringify(response) + '\n';
    if (Buffer.byteLength(line) > BRIDGE_LIMITS.outputBytes) throw new BridgeRejected('output_capacity');
    // One bounded frame in flight. Waiting for its completion callback also
    // handles asynchronous errors when write() returns true. Startup/error
    // replies use this bound even when argument parsing produced no run timer.
    await new Promise<void>((resolveWrite, rejectWrite) => {
      let completed = false;
      const finish = (error?: BridgeRejected) => {
        if (completed) return;
        completed = true; clearTimeout(writeTimer); interruptWrite = undefined;
        if (error) { outputFailed = true; rejectWrite(error); }
        else resolveWrite();
      };
      const writeTimer = setTimeout(() => finish(new BridgeRejected('output_deadline_exceeded')), BRIDGE_LIMITS.outputWriteMs);
      interruptWrite = finish;
      try {
        output.write(line, error => finish(error ? new BridgeRejected('output_stream_failed') : undefined));
      } catch { finish(new BridgeRejected('output_stream_failed')); }
    });
  };
  const control = (code: string): BridgeResponse => ({ id: null, operation: 'unknown', status: 'rejected', code,
    cost: { latency_ms: 0, provider_calls: 0 } });
  try {
    const options = parseBridgeArgs(argv); bridge = new IsolatedChainBridge(options);
    timer = setTimeout(() => stop('deadline_exceeded'), options.deadlineMs!);
    let pending = Buffer.alloc(0); let discarding = false;
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset); const final = end !== -1;
        const piece = chunk.subarray(offset, final ? end : chunk.length); offset = final ? end + 1 : chunk.length;
        if (!discarding) {
          if (pending.length + piece.length > BRIDGE_LIMITS.lineBytes) {
            pending = Buffer.alloc(0); discarding = true;
            await emit(bridge.processLine(Buffer.alloc(BRIDGE_LIMITS.lineBytes + 1)));
          } else pending = Buffer.concat([pending, piece]);
        }
        if (final) {
          if (!discarding) await emit(bridge.processLine(pending));
          pending = Buffer.alloc(0); discarding = false;
        }
        if (terminalError) throw terminalError;
        if (bridge.stopped) return 0;
      }
    }
    if (pending.length && !discarding && !bridge.stopped) await emit(bridge.processLine(pending));
    if (terminalError) throw terminalError;
    return 0;
  } catch (error) {
    const failure = terminalError ?? error;
    // A partially written or broken output cannot reliably carry another error
    // frame. Report once only if the channel has not already failed.
    if (!outputFailed) {
      try { await emit(control(failure instanceof AtomicMemoryPortError ? failure.code : 'bridge_startup_or_stream_failed'), true); }
      catch { /* Exit status remains failure when the error frame cannot drain. */ }
    }
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    bridge?.close();
    if (outputFailed) {
      input.destroy(); output.destroy();
      // Writable reports a failed callback and its error event separately.
      // Retain the listener through that event before releasing this boundary.
      await new Promise<void>(resolveDone => setImmediate(resolveDone));
    }
    output.removeListener('error', onOutputError); output.removeListener('close', onOutputClose);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runBridgeCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
