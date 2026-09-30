/** Isolated SQLite vertical slice. Not installed into Gateway/Hermes by default. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, EpisodicMetadata } from '../record/l1-writer.js';
import type { L1RecordRow } from '../store/types.js';
import { AtomicMemoryPortError, SqliteAtomicMemoryPort } from './sqlite-atomic-port.js';

export type Domain = { teamId: string; userId: string; agentId: string; taskId: string };
export type MemoryHit = Pick<L1RecordRow, 'record_id' | 'version' | 'content' | 'type' | 'team_id' | 'user_id' | 'agent_id' | 'task_id'>;
export type FeedbackKind = 'update' | 'retire' | 'support' | 'refute' | 'defer' | 'diagnostic';
export interface FeedbackCommand {
  eventId: string; captureId: string; domain: Domain; receiptId: string; parentTurnId: string;
  targetId: string; expectedChainVersion: number; expectedMemoryVersion: number;
  kind: FeedbackKind; object: 'memory_content' | 'memory_retrieval' | 'answer' | 'tool' | 'workflow' | 'unknown';
  directUser: boolean; durable: boolean; newContent?: string;
  source: { role: 'user'; sessionId: string; turnId: string; text: string;
    start: number; end: number; quote: string };
}
/** A trusted host captures the current message BEFORE requesting a proposal.
 * This is provenance consistency, not a semantic authorization oracle. */
export interface SourceCapture {
  captureId: string; domain: Domain; sessionId: string; turnId: string;
  parentReceiptId: string | null; text: string;
}
export interface SourceAddCommand {
  eventId: string; captureId: string; chainId: string; memoryId: string; domain: Domain;
  memoryScope: 'user_memory' | 'project_memory' | 'task_experience';
  object: 'memory_content'; directUser: boolean; durable: boolean;
  source: FeedbackCommand['source']; contentStart: number; contentEnd: number; contentQuote: string;
}
export const SOURCE_ADD_LIMITS = Object.freeze({ activePerDomain: 5, contentBytes: 4096 });
type Head = { chain_id: string; domain_json: string; chain_version: number; memory_id: string;
  memory_version: number; content_hash: string; state: 'active' | 'retired'; evidence_count: number };
type ReceiptHit = { chainId: string; chainVersion: number; memoryId: string; memoryVersion: number; contentHash: string };
export type DecisionResult = { status: 'applied' | 'recorded' | 'delegate_baseline'; action: string;
  chainId?: string; chainVersion?: number; memoryId?: string; memoryVersion?: number };
export const DEFAULT_CHAIN_LIMITS = Object.freeze({ chains: 256, versionsPerChain: 20,
  evidencePerVersion: 20, events: 4096, receipts: 256, candidateK: 20, k: 5,
  inputBytes: 8192, snapshotBytes: 16384, injectionBytes: 8192, receiptTtlMs: 1800000 });
export type ChainLimits = { [K in keyof typeof DEFAULT_CHAIN_LIMITS]: number };
export class ChainRejected extends AtomicMemoryPortError { constructor(code: string) { super(code); this.name = 'ChainRejected'; } }
const reject: (code: string) => never = (code) => { throw new ChainRejected(code); };
function smallText(value: unknown, cap = 128): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value) > cap || /[\u0000-\u001f]/u.test(value)) reject('invalid_identifier');
}
function domainJson(domain: Domain): string {
  for (const key of ['teamId', 'userId', 'agentId'] as const) {
    smallText(domain?.[key]); if (domain[key] === 'default') reject('explicit_domain_required');
  }
  if (typeof domain?.taskId !== 'string' || Buffer.byteLength(domain.taskId) > 128 || /[\u0000-\u001f]/u.test(domain.taskId)) reject('explicit_task_dimension_required');
  return JSON.stringify([domain.teamId, domain.userId, domain.agentId, domain.taskId]);
}
function normal(value: string): string { return value.replace(/\r\n?/g, '\n').normalize('NFC'); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Semantic scope is not part of the historical content fingerprint. Missing
 * and explicit null both mean unknown; neither is inferred from record type. */
function feedbackMemoryScope(metadataJson: unknown, cap: number): string | null {
  if (typeof metadataJson !== 'string' || Buffer.byteLength(metadataJson) > cap) reject('invalid_memory_scope_metadata');
  let metadata: unknown;
  try { metadata = JSON.parse(metadataJson); } catch { reject('invalid_memory_scope_metadata'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) reject('invalid_memory_scope_metadata');
  const value = (metadata as Record<string, unknown>).feedback_memory_scope;
  if (value === undefined || value === null) return null;
  if (value !== 'user_memory' && value !== 'project_memory' && value !== 'task_experience') reject('invalid_memory_scope_metadata');
  return value;
}
/** Fixed, alphabetically ordered string projection; no floating-point canonicalization. */
export function contentFingerprint(row: MemoryHit): string {
  return hash(JSON.stringify({ agent_id: normal(row.agent_id), background: '', content: normal(row.content),
    task_id: normal(row.task_id), team_id: normal(row.team_id), type: normal(row.type), user_id: normal(row.user_id) }));
}
function stable(value: unknown, cap = 16384): string {
  let nodes = 0; let bytes = 0; const path = new Set<object>();
  const add = (text: string) => { bytes += Buffer.byteLength(text); if (bytes > cap) reject('snapshot_capacity'); return text; };
  const walk = (item: unknown, depth: number): string => {
    if (++nodes > 512 || depth > 8) reject('input_complexity');
    if (item === null || typeof item === 'boolean') return add(JSON.stringify(item));
    if (typeof item === 'number' && Number.isFinite(item)) return add(JSON.stringify(item));
    if (typeof item === 'string') { if (Buffer.byteLength(item) > cap) reject('snapshot_capacity'); return add(JSON.stringify(item)); }
    if (!item || typeof item !== 'object' || path.has(item)) reject('invalid_json_input');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) reject('invalid_json_input');
    path.add(item);
    if (Array.isArray(item)) {
      if (item.length > 64) reject('input_complexity');
      const result = add('[') + item.map(x => walk(x, depth + 1)).join(add(',')) + add(']'); path.delete(item); return result;
    }
    const entries: [string, unknown][] = [];
    for (const key in item) {
      if (!Object.hasOwn(item, key) || entries.length >= 128 || Buffer.byteLength(key) > 256) reject('input_complexity');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (descriptor.get || descriptor.set) reject('invalid_json_input');
      if (descriptor.value !== undefined) entries.push([key, descriptor.value]);
    }
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const result = add('{') + entries.map(([k, v]) => add(JSON.stringify(k) + ':') + walk(v, depth + 1)).join(add(',')) + add('}');
    path.delete(item); return result;
  };
  const result = walk(value, 0); if (Buffer.byteLength(result) > cap) reject('snapshot_capacity'); return result;
}

export class SqliteEvidenceChain {
  readonly limits: ChainLimits;
  private readonly enabled: boolean;
  constructor(private readonly port: SqliteAtomicMemoryPort, private readonly db: DatabaseSync,
    options: { mode?: 'off' | 'isolated'; limits?: Partial<ChainLimits>; now?: () => number } = {}) {
    if (options.mode !== undefined && options.mode !== 'off' && options.mode !== 'isolated') reject('unsupported_mode');
    this.enabled = options.mode === 'isolated'; this.now = options.now ?? Date.now;
    for (const key of Object.keys(options.limits ?? {})) {
      if (!Object.hasOwn(DEFAULT_CHAIN_LIMITS, key)) reject('unknown_capacity_option');
    }
    this.limits = Object.freeze({ ...DEFAULT_CHAIN_LIMITS, ...options.limits });
    for (const key of Object.keys(DEFAULT_CHAIN_LIMITS) as (keyof ChainLimits)[]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > DEFAULT_CHAIN_LIMITS[key]) reject('invalid_capacity');
    }
    if (this.limits.k > this.limits.candidateK) reject('invalid_retrieval_capacity');
    if (!this.enabled) return;
    if (db !== port.getRawDb()) reject('same_sqlite_connection_required');
    port.atomic(() => db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_heads(chain_id TEXT PRIMARY KEY,domain_json TEXT NOT NULL,
        chain_version INTEGER NOT NULL,memory_id TEXT UNIQUE NOT NULL,memory_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,state TEXT NOT NULL,evidence_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS feedback_versions(chain_id TEXT NOT NULL,chain_version INTEGER NOT NULL,
        previous_version INTEGER,record_snapshot TEXT NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,
        source_span_json TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL,PRIMARY KEY(chain_id,chain_version));
      CREATE TABLE IF NOT EXISTS feedback_events(event_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,
        chain_id TEXT,kind TEXT NOT NULL,result_json TEXT NOT NULL,source_span_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_receipts(receipt_id TEXT PRIMARY KEY,domain_json TEXT NOT NULL,
        session_id TEXT NOT NULL,turn_id TEXT NOT NULL,created_ms INTEGER NOT NULL,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_captures(capture_id TEXT PRIMARY KEY,domain_json TEXT NOT NULL,
        session_id TEXT NOT NULL,turn_id TEXT NOT NULL,parent_receipt_id TEXT UNIQUE NOT NULL,
        text_hash TEXT NOT NULL,UNIQUE(domain_json,session_id,turn_id));
      CREATE TABLE IF NOT EXISTS feedback_source_uses(domain_json TEXT NOT NULL,session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,purpose TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL,
        PRIMARY KEY(domain_json,session_id,turn_id,purpose));
      CREATE TRIGGER IF NOT EXISTS feedback_versions_no_update BEFORE UPDATE ON feedback_versions BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_versions_no_delete BEFORE DELETE ON feedback_versions BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_events_no_update BEFORE UPDATE ON feedback_events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_events_no_delete BEFORE DELETE ON feedback_events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_receipts_no_update BEFORE UPDATE ON feedback_receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_receipts_no_delete BEFORE DELETE ON feedback_receipts BEGIN SELECT RAISE(ABORT,'immutable_receipt'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_captures_no_update BEFORE UPDATE ON feedback_captures BEGIN SELECT RAISE(ABORT,'immutable_capture'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_captures_no_delete BEFORE DELETE ON feedback_captures BEGIN SELECT RAISE(ABORT,'immutable_capture'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_source_uses_no_update BEFORE UPDATE ON feedback_source_uses BEGIN SELECT RAISE(ABORT,'immutable_source_use'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_source_uses_no_delete BEFORE DELETE ON feedback_source_uses BEGIN SELECT RAISE(ABORT,'immutable_source_use'); END;
    `));
  }
  private readonly now: () => number;
  private count(table: 'heads' | 'events' | 'receipts'): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM feedback_' + table).get() as { n: number }).n);
  }
  private head(id: string, domain: string): Head {
    const row = this.db.prepare('SELECT * FROM feedback_heads WHERE memory_id=? AND domain_json=?').get(id, domain) as Head | undefined;
    return row ?? reject('unmanaged_or_wrong_domain_target');
  }
  private live(head: Head, domain: Domain): L1RecordRow {
    if (head.state !== 'active') reject('target_retired');
    const row = this.port.getExact(domain, head.memory_id);
    if (!row || row.version !== head.memory_version || contentFingerprint(row) !== head.content_hash) reject('external_change_or_missing_view');
    return row;
  }
  /** New mutations must not inherit a semantic scope changed by an external
   * L1 writer without a version/content change. Called only after event replay
   * and receipt/current-head checks, inside the same write transaction. */
  private assertMemoryScopeUnchanged(head: Head, live: L1RecordRow): void {
    const version = this.db.prepare(`SELECT CASE WHEN length(CAST(record_snapshot AS BLOB)) <= ?
      THEN record_snapshot ELSE NULL END AS record_snapshot FROM feedback_versions
      WHERE chain_id=? AND chain_version=? AND state='active' AND content_hash=? LIMIT 1`)
      .get(this.limits.snapshotBytes, head.chain_id, head.chain_version, head.content_hash) as
      { record_snapshot: string | null } | undefined;
    if (!version || typeof version.record_snapshot !== 'string') reject('memory_scope_snapshot_invalid');
    let snapshot: L1RecordRow;
    try { snapshot = JSON.parse(version.record_snapshot) as L1RecordRow; } catch { return reject('memory_scope_snapshot_invalid'); }
    if (!snapshot || typeof snapshot !== 'object' || snapshot.record_id !== live.record_id ||
      snapshot.version !== live.version) reject('memory_scope_snapshot_invalid');
    if (feedbackMemoryScope(snapshot.metadata_json, this.limits.snapshotBytes) !==
      feedbackMemoryScope(live.metadata_json, this.limits.snapshotBytes)) reject('external_memory_scope_changed');
  }
  private replay(eventId: string, requestHash: string, retirement = false): DecisionResult | undefined {
    const row = this.db.prepare('SELECT request_hash,result_json FROM feedback_events WHERE event_id=?').get(eventId) as { request_hash: string; result_json: string } | undefined;
    if (row && row.request_hash !== requestHash) reject('event_id_payload_conflict');
    if (row) return JSON.parse(row.result_json) as DecisionResult;
    if (this.count('events') >= this.limits.events + (retirement ? this.limits.chains : 0)) reject('event_capacity');
  }
  private event(id: string, requestHash: string, kind: string, result: DecisionResult, source: object = {}): DecisionResult {
    this.db.prepare('INSERT INTO feedback_events VALUES(?,?,?,?,?,?)').run(id, requestHash, result.chainId ?? null, kind, JSON.stringify(result), JSON.stringify(source));
    return result;
  }
  /** Lazily created only by the NEW source-capture path. Existing seed/capture
   * experiments retain their previous schema and execution behavior. */
  private createSourceCaptureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback_add_captures(
      capture_id TEXT PRIMARY KEY,domain_json TEXT NOT NULL,session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,parent_receipt_id TEXT,text_hash TEXT NOT NULL,created_ms INTEGER NOT NULL,
      UNIQUE(domain_json,session_id,turn_id));
      CREATE UNIQUE INDEX IF NOT EXISTS feedback_add_capture_parent
        ON feedback_add_captures(domain_json,session_id,COALESCE(parent_receipt_id,''));
      CREATE TRIGGER IF NOT EXISTS feedback_add_captures_no_update BEFORE UPDATE ON feedback_add_captures
        BEGIN SELECT RAISE(ABORT,'immutable_source_capture'); END;
      CREATE TRIGGER IF NOT EXISTS feedback_add_captures_no_delete BEFORE DELETE ON feedback_add_captures
        BEGIN SELECT RAISE(ABORT,'immutable_source_capture'); END;`);
  }
  captureSource(input: SourceCapture): void {
    if (!this.enabled) return;
    smallText(input.captureId); smallText(input.sessionId); smallText(input.turnId);
    if (input.parentReceiptId !== null) smallText(input.parentReceiptId);
    const scope = domainJson(input.domain);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') ||
      Buffer.byteLength(input.text) > this.limits.inputBytes) reject('invalid_user_source');
    this.port.atomic(() => {
      this.createSourceCaptureSchema();
      const prior = this.db.prepare('SELECT * FROM feedback_add_captures WHERE capture_id=?').get(input.captureId) as
        { domain_json: string; session_id: string; turn_id: string; parent_receipt_id: string | null; text_hash: string } | undefined;
      if (prior) {
        if (prior.domain_json !== scope || prior.session_id !== input.sessionId || prior.turn_id !== input.turnId ||
          prior.parent_receipt_id !== input.parentReceiptId || prior.text_hash !== hash(input.text)) reject('capture_id_payload_conflict');
        return;
      }
      if (Number(this.db.prepare('SELECT count(*) AS n FROM feedback_add_captures').get()!.n) >= this.limits.receipts)
        reject('source_capture_capacity');
      this.assertSourceParent(scope, input.sessionId, input.turnId, input.parentReceiptId);
      if (this.db.prepare(`SELECT 1 FROM feedback_add_captures WHERE domain_json=? AND session_id=?
        AND (turn_id=? OR parent_receipt_id IS ?)`).get(scope, input.sessionId, input.turnId, input.parentReceiptId))
        reject('source_capture_already_registered');
      const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) reject('invalid_clock');
      this.db.prepare('INSERT INTO feedback_add_captures VALUES(?,?,?,?,?,?,?)').run(input.captureId, scope,
        input.sessionId, input.turnId, input.parentReceiptId, hash(input.text), now);
    });
  }
  private assertSourceParent(scope: string, sessionId: string, turnId: string, parent: string | null): void {
    const latest = this.db.prepare(`SELECT receipt_id,turn_id,created_ms FROM feedback_receipts
      WHERE domain_json=? AND session_id=? ORDER BY rowid DESC LIMIT 1`).get(scope, sessionId) as
      { receipt_id: string; turn_id: string; created_ms: number } | undefined;
    if ((latest?.receipt_id ?? null) !== parent || latest?.turn_id === turnId) reject('source_parent_not_latest_render');
    if (latest) {
      const age = this.now() - latest.created_ms;
      if (!Number.isSafeInteger(age) || age < 0 || age > this.limits.receiptTtlMs) reject('receipt_expired_or_clock_changed');
    }
  }
  /** The host owns event/chain/memory IDs and scope. No target or receipt can be
   * nominated by the model. First-turn ADD works without fabricating delivery. */
  addFromSource(command: SourceAddCommand): DecisionResult {
    if (!this.enabled) return { status: 'delegate_baseline', action: 'unchanged' };
    for (const id of [command.eventId, command.captureId, command.chainId, command.memoryId]) smallText(id);
    const scope = domainJson(command.domain);
    if (Object.keys(command.domain).length !== 4 || command.object !== 'memory_content' ||
      command.directUser !== true || command.durable !== true ||
      !['user_memory', 'project_memory', 'task_experience'].includes(command.memoryScope)) reject('explicit_add_authority_required');
    const source = command.source;
    if (source?.role !== 'user' || typeof source.text !== 'string' || !source.text.trim() ||
      source.text.includes('\0') || Buffer.byteLength(source.text) > this.limits.inputBytes) reject('invalid_user_source');
    smallText(source.sessionId); smallText(source.turnId);
    const points = Array.from(source.text);
    const validSpan = (start: number, end: number, quote: string) => Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start >= 0 && end > start && end <= points.length && typeof quote === 'string' && !!quote.trim()
      && points.slice(start, end).join('') === quote && source.text.indexOf(quote) === source.text.lastIndexOf(quote);
    if (!validSpan(source.start, source.end, source.quote)) reject('source_span_mismatch');
    if (!validSpan(command.contentStart, command.contentEnd, command.contentQuote) ||
      command.contentStart < source.start || command.contentEnd > source.end ||
      Buffer.byteLength(command.contentQuote) > SOURCE_ADD_LIMITS.contentBytes) reject('add_content_source_mismatch');
    const requestHash = hash(stable(command, this.limits.inputBytes * 3 + 8192));
    const span = { turn_id: source.turnId, unit: 'unicode_code_point', start: source.start, end: source.end,
      quote_hash: hash(source.quote), content_start: command.contentStart, content_end: command.contentEnd,
      content_quote_hash: hash(command.contentQuote) };
    return this.port.atomic(() => {
      const prior = this.replay(command.eventId, requestHash); if (prior) return prior;
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_add_captures'").get()) reject('source_capture_missing');
      const captured = this.db.prepare(`SELECT parent_receipt_id,text_hash,created_ms FROM feedback_add_captures
        WHERE capture_id=? AND domain_json=? AND session_id=? AND turn_id=?`).get(command.captureId, scope,
        source.sessionId, source.turnId) as { parent_receipt_id: string | null; text_hash: string; created_ms: number } | undefined;
      if (!captured || captured.text_hash !== hash(source.text)) return reject('source_capture_mismatch');
      const age = this.now() - captured.created_ms;
      if (!Number.isSafeInteger(age) || age < 0 || age > this.limits.receiptTtlMs) reject('source_capture_expired_or_clock_changed');
      this.assertSourceParent(scope, source.sessionId, source.turnId, captured.parent_receipt_id);
      if (this.count('heads') >= this.limits.chains) reject('chain_capacity');
      if (Number(this.db.prepare("SELECT count(*) AS n FROM feedback_heads WHERE domain_json=? AND state='active'").get(scope)!.n)
        >= SOURCE_ADD_LIMITS.activePerDomain) reject('active_memory_capacity');
      if (this.db.prepare('SELECT 1 FROM feedback_heads WHERE chain_id=? OR memory_id=?').get(command.chainId, command.memoryId))
        reject('chain_or_memory_already_managed');
      this.useSource(scope, source.sessionId, source.turnId, 'mutation', command.eventId);
      const timestamp = new Date(captured.created_ms).toISOString();
      const metadata: EpisodicMetadata & { source: 'source_bound_feedback'; feedback_memory_scope: SourceAddCommand['memoryScope'] } = {
        source: 'source_bound_feedback', feedback_memory_scope: command.memoryScope,
      };
      const record: MemoryRecord = { id: command.memoryId, content: command.contentQuote, type: 'instruction', version: 1,
        priority: 50, scene_name: '', source_message_ids: [source.turnId],
        metadata,
        timestamps: [timestamp], createdAt: timestamp, updatedAt: timestamp,
        sessionKey: source.sessionId, sessionId: source.sessionId, ...command.domain };
      const created = this.port.createIfAbsent(command.domain, record);
      if (created.status !== 'applied') reject('add_memory_conflict');
      const row = this.port.getExact(command.domain, command.memoryId);
      if (!row || row.version !== 1 || row.content !== command.contentQuote) return reject('precise_readback_failed');
      const fingerprint = contentFingerprint(row);
      this.db.prepare('INSERT INTO feedback_heads VALUES(?,?,?,?,?,?,?,0)').run(command.chainId, scope, 1,
        row.record_id, row.version, fingerprint, 'active');
      this.version(command.chainId, 1, row, fingerprint, 'active', command.eventId, span);
      return this.event(command.eventId, requestHash, 'add_from_source', { status: 'applied', action: 'add',
        chainId: command.chainId, chainVersion: 1, memoryId: row.record_id, memoryVersion: row.version }, span);
    });
  }
  seed(eventId: string, chainId: string, domain: Domain, record: MemoryRecord): DecisionResult {
    if (!this.enabled) return { status: 'delegate_baseline', action: 'unchanged' };
    smallText(eventId); smallText(chainId); smallText(record?.id); const scope = domainJson(domain);
    const serialized = stable(record, this.limits.snapshotBytes);
    const requestHash = hash(JSON.stringify(['seed', scope, chainId, serialized]));
    return this.port.atomic(() => {
      const previous = this.replay(eventId, requestHash); if (previous) return previous;
      if (this.count('heads') >= this.limits.chains) reject('chain_capacity');
      if (this.db.prepare('SELECT 1 FROM feedback_heads WHERE chain_id=? OR memory_id=?').get(chainId, record.id)) reject('chain_or_memory_already_managed');
      const created = this.port.createIfAbsent(domain, record);
      if (created.status !== 'applied') reject('seed_memory_conflict');
      const row = this.port.getExact(domain, record.id)!; const fingerprint = contentFingerprint(row);
      this.db.prepare('INSERT INTO feedback_heads VALUES(?,?,?,?,?,?,?,0)').run(chainId, scope, 1, row.record_id, row.version, fingerprint, 'active');
      this.version(chainId, 1, row, fingerprint, 'active', eventId, {});
      return this.event(eventId, requestHash, 'seed', { status: 'applied', action: 'add', chainId,
        chainVersion: 1, memoryId: row.record_id, memoryVersion: row.version });
    });
  }
  private version(chainId: string, version: number, row: L1RecordRow | null, fingerprint: string,
    state: string, eventId: string, source: object): void {
    const snapshot = JSON.stringify(row);
    if (Buffer.byteLength(snapshot) > this.limits.snapshotBytes) reject('snapshot_capacity');
    this.db.prepare('INSERT INTO feedback_versions VALUES(?,?,?,?,?,?,?,?)').run(chainId, version,
      version > 1 ? version - 1 : null, snapshot, fingerprint, state, JSON.stringify(source), eventId);
  }

  /** Receipt records only final rendered whole items, NOT every search hit. */
  composeInjection(input: { receiptId: string; domain: Domain; sessionId: string; turnId: string;
    hits: MemoryHit[]; baselineText: string; derivedTexts?: string[] }): {
      mode: 'off' | 'isolated'; text: string; receiptId: string | null; memoryIds: string[]; dropped: number;
    } {
    if (!this.enabled) return { mode: 'off', text: input.baselineText, receiptId: null, memoryIds: [], dropped: 0 };
    smallText(input.receiptId); smallText(input.sessionId); smallText(input.turnId); const scope = domainJson(input.domain);
    if (!Array.isArray(input.hits) || input.hits.length > this.limits.candidateK) reject('candidate_capacity');
    if (input.derivedTexts && input.derivedTexts.length) reject('derived_layers_not_supported_in_isolated_mode');
    return this.port.atomic(() => {
      if (this.count('receipts') >= this.limits.receipts) reject('receipt_capacity');
      if (this.db.prepare('SELECT 1 FROM feedback_receipts WHERE receipt_id=?').get(input.receiptId)) reject('receipt_id_already_used');
      const kept: ReceiptHit[] = []; const lines: string[] = []; const seen = new Set<string>();
      for (const hit of input.hits) {
        if (kept.length >= this.limits.k) break;
        stable(hit, this.limits.snapshotBytes);
        smallText(hit.record_id); if (seen.has(hit.record_id)) continue;
        const head = this.db.prepare('SELECT * FROM feedback_heads WHERE memory_id=? AND domain_json=? AND state=\'active\'').get(hit.record_id, scope) as Head | undefined;
        if (!head || hit.version !== head.memory_version || contentFingerprint(hit) !== head.content_hash) continue;
        const exact = this.live(head, input.domain);
        const line = '- [memory ' + exact.record_id + '@' + head.chain_version + '] ' + JSON.stringify(exact.content);
        if (Buffer.byteLength([...lines, line].join('\n')) > this.limits.injectionBytes) continue;
        seen.add(hit.record_id); lines.push(line); kept.push({ chainId: head.chain_id, chainVersion: head.chain_version,
          memoryId: exact.record_id, memoryVersion: exact.version, contentHash: head.content_hash });
      }
      const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) reject('invalid_clock');
      this.db.prepare('INSERT INTO feedback_receipts VALUES(?,?,?,?,?,?)').run(input.receiptId, scope,
        input.sessionId, input.turnId, now, JSON.stringify(kept));
      return { mode: 'isolated', text: lines.join('\n'), receiptId: input.receiptId,
        memoryIds: kept.map(x => x.memoryId), dropped: input.hits.length - kept.length };
    });
  }

  /** Trusted host event hook, never a model tool. Wire actual user messages here
   * before classification. This isolated module cannot authenticate Hermes users. */
  captureUserTurn(input: { captureId: string; domain: Domain; sessionId: string; turnId: string;
    parentReceiptId: string; text: string }): void {
    if (!this.enabled) return;
    smallText(input.captureId); smallText(input.sessionId); smallText(input.turnId); smallText(input.parentReceiptId);
    const scope = domainJson(input.domain);
    if (typeof input.text !== 'string' || !input.text || Buffer.byteLength(input.text) > this.limits.inputBytes) reject('invalid_user_source');
    this.port.atomic(() => {
      const prior = this.db.prepare('SELECT * FROM feedback_captures WHERE capture_id=?').get(input.captureId) as
        { domain_json: string; session_id: string; turn_id: string; parent_receipt_id: string; text_hash: string } | undefined;
      if (prior) {
        if (prior.domain_json !== scope || prior.session_id !== input.sessionId || prior.turn_id !== input.turnId ||
          prior.parent_receipt_id !== input.parentReceiptId || prior.text_hash !== hash(input.text)) reject('capture_id_payload_conflict');
        return;
      }
      const latest = this.db.prepare('SELECT receipt_id,turn_id FROM feedback_receipts WHERE domain_json=? AND session_id=? ORDER BY rowid DESC LIMIT 1')
        .get(scope, input.sessionId) as { receipt_id: string; turn_id: string } | undefined;
      if (!latest || latest.receipt_id !== input.parentReceiptId || latest.turn_id === input.turnId) reject('capture_parent_not_latest_render');
      if (this.db.prepare('SELECT 1 FROM feedback_captures WHERE capture_id=? OR parent_receipt_id=? OR (domain_json=? AND session_id=? AND turn_id=?)')
        .get(input.captureId, input.parentReceiptId, scope, input.sessionId, input.turnId)) reject('capture_already_registered');
      this.db.prepare('INSERT INTO feedback_captures VALUES(?,?,?,?,?,?)').run(input.captureId, scope,
        input.sessionId, input.turnId, input.parentReceiptId, hash(input.text));
    });
  }

  apply(command: FeedbackCommand): DecisionResult {
    if (!this.enabled) return { status: 'delegate_baseline', action: 'unchanged' };
    smallText(command.eventId); const scope = domainJson(command.domain);
    if (!['update', 'retire', 'support', 'refute', 'defer', 'diagnostic'].includes(command.kind)) reject('invalid_feedback_kind');
    if (!['memory_content', 'memory_retrieval', 'answer', 'tool', 'workflow', 'unknown'].includes(command.object) ||
      typeof command.directUser !== 'boolean' || typeof command.durable !== 'boolean') reject('invalid_feedback_attributes');
    const source = command.source;
    if (source?.role !== 'user' || typeof source.text !== 'string' || Buffer.byteLength(source.text) > this.limits.inputBytes) reject('invalid_user_source');
    smallText(source.sessionId); smallText(source.turnId);
    const points = Array.from(source.text);
    if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0 ||
      source.end <= source.start || source.end > points.length || points.slice(source.start, source.end).join('') !== source.quote) reject('source_span_mismatch');
    const span = { turn_id: source.turnId, unit: 'unicode_code_point', start: source.start, end: source.end,
      quote_hash: hash(source.quote) }; // no raw dialogue or diagnosis text in event logs
    const requestHash = hash(stable(command, this.limits.inputBytes * 2 + 4096));
    return this.port.atomic(() => {
      const previous = this.replay(command.eventId, requestHash, command.kind === 'retire'); if (previous) return previous;
      smallText(command.captureId);
      const captured = this.db.prepare('SELECT parent_receipt_id,text_hash FROM feedback_captures WHERE capture_id=? AND domain_json=? AND session_id=? AND turn_id=?')
        .get(command.captureId, scope, source.sessionId, source.turnId) as { parent_receipt_id: string; text_hash: string } | undefined;
      if (!captured || captured.parent_receipt_id !== command.receiptId || captured.text_hash !== hash(source.text)) reject('source_capture_mismatch');
      const capturedParent = this.db.prepare('SELECT turn_id FROM feedback_receipts WHERE receipt_id=?').get(captured.parent_receipt_id) as { turn_id: string };
      if (capturedParent.turn_id !== command.parentTurnId) reject('source_capture_mismatch');
      if (command.kind === 'defer' || command.kind === 'diagnostic') {
        return this.event(command.eventId, requestHash, command.kind,
          { status: 'recorded', action: 'noop' }, span);
      }
      smallText(command.receiptId); smallText(command.parentTurnId); smallText(command.targetId);
      if (!Number.isSafeInteger(command.expectedChainVersion) || command.expectedChainVersion < 1 ||
        !Number.isSafeInteger(command.expectedMemoryVersion) || command.expectedMemoryVersion < 1) reject('invalid_expected_version');
      const receipt = this.db.prepare('SELECT * FROM feedback_receipts WHERE receipt_id=? AND domain_json=? AND session_id=? AND turn_id=?')
        .get(command.receiptId, scope, source.sessionId, command.parentTurnId) as { payload_json: string; created_ms: number } | undefined;
      if (!receipt || source.turnId === command.parentTurnId) reject('missing_or_wrong_parent_receipt');
      const age = this.now() - receipt.created_ms;
      if (!Number.isSafeInteger(age) || age < 0 || age > this.limits.receiptTtlMs) reject('receipt_expired_or_clock_changed');
      const matches = (JSON.parse(receipt.payload_json) as ReceiptHit[]).filter(x => x.memoryId === command.targetId);
      if (matches.length !== 1) reject('target_not_uniquely_rendered');
      const target = matches[0];
      if (target.chainVersion !== command.expectedChainVersion || target.memoryVersion !== command.expectedMemoryVersion) reject('receipt_version_mismatch');
      const head = this.head(command.targetId, scope);
      if (head.chain_version !== target.chainVersion || head.content_hash !== target.contentHash) reject('stale_receipt');
      const old = this.live(head, command.domain);
      if (command.kind === 'support' || command.kind === 'refute') {
        if (command.directUser !== true || !['memory_content', 'memory_retrieval'].includes(command.object)) reject('explicit_memory_evidence_required');
        if (head.evidence_count >= this.limits.evidencePerVersion) reject('evidence_capacity');
        this.useSource(scope, source.sessionId, source.turnId, 'evidence', command.eventId);
        this.db.prepare('UPDATE feedback_heads SET evidence_count=evidence_count+1 WHERE chain_id=?').run(head.chain_id);
        return this.event(command.eventId, requestHash, command.kind, { status: 'recorded', action: 'noop',
          chainId: head.chain_id, chainVersion: head.chain_version, memoryId: head.memory_id, memoryVersion: old.version }, span);
      }
      if (command.object !== 'memory_content' || command.directUser !== true ||
        (command.kind === 'update' && command.durable !== true)) reject('explicit_memory_authority_required');
      this.assertMemoryScopeUnchanged(head, old);
      // One extra tombstone revision is reserved, even at the normal version cap.
      if (command.kind === 'update' && head.chain_version >= this.limits.versionsPerChain) reject('version_capacity');
      this.useSource(scope, source.sessionId, source.turnId, 'mutation', command.eventId);
      const nextVersion = head.chain_version + 1;
      let next: L1RecordRow | null = null;
      if (command.kind === 'retire') {
        if (this.port.deleteIfVersion(command.domain, head.memory_id, old.version).status !== 'applied') reject('memory_cas_conflict');
      } else {
        if (typeof command.newContent !== 'string' || !command.newContent.trim() || Buffer.byteLength(command.newContent) > 4096) reject('invalid_new_content');
        const record: MemoryRecord = { id: old.record_id, content: normal(command.newContent), type: old.type as MemoryRecord['type'],
          priority: old.priority, scene_name: old.scene_name, source_message_ids: [source.turnId], metadata: JSON.parse(old.metadata_json),
          timestamps: old.timestamp_str ? [old.timestamp_str] : [], createdAt: old.created_time, updatedAt: new Date(this.now()).toISOString(),
          version: old.version + 1, sessionKey: old.session_key, sessionId: old.session_id, ...command.domain };
        if (this.port.updateIfVersion(command.domain, old.record_id, old.version, record).status !== 'applied') reject('memory_cas_conflict');
        next = this.port.getExact(command.domain, old.record_id);
        if (!next || next.content !== record.content || next.version !== record.version) reject('precise_readback_failed');
      }
      const fingerprint = next ? contentFingerprint(next) : head.content_hash;
      this.version(head.chain_id, nextVersion, next, fingerprint, next ? 'active' : 'retired', command.eventId, span);
      const result = this.db.prepare('UPDATE feedback_heads SET chain_version=?,memory_version=?,content_hash=?,state=?,evidence_count=0 WHERE chain_id=? AND chain_version=?')
        .run(nextVersion, next?.version ?? old.version + 1, fingerprint, next ? 'active' : 'retired', head.chain_id, head.chain_version);
      if (Number(result.changes) !== 1) reject('head_cas_conflict');
      return this.event(command.eventId, requestHash, command.kind, { status: 'applied', action: command.kind,
        chainId: head.chain_id, chainVersion: nextVersion, memoryId: old.record_id, memoryVersion: next?.version ?? old.version + 1 }, span);
    });
  }

  private useSource(scope: string, sessionId: string, turnId: string, purpose: string, eventId: string): void {
    if (this.db.prepare('SELECT 1 FROM feedback_source_uses WHERE domain_json=? AND session_id=? AND turn_id=? AND purpose=?')
      .get(scope, sessionId, turnId, purpose)) reject('source_turn_already_used');
    this.db.prepare('INSERT INTO feedback_source_uses VALUES(?,?,?,?,?)').run(scope, sessionId, turnId, purpose, eventId);
  }
}
