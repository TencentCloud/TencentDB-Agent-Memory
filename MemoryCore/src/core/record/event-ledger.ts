/**
 * Memory change-ledger writer with a JSONL outbox.
 *
 * Every memory event is appended to this writer's shard
 * `events/YYYY-MM-DD.<writerId>.jsonl` (`events/YYYY-MM-DD.jsonl` when no
 * writer id is configured) via the StorageAdapter, so local fs and COS behave
 * the same, before it is written
 * to the configured store. Both steps are best-effort and never throw, so the
 * write path keeps its availability semantics. Because each event carries a
 * stable `event_id` and every backend treats a repeated `event_id` as a no-op,
 * `replayLedgerEvents` can re-apply the outbox any number of times to backfill
 * events the store missed (backend outage, node rebuild, backend migration).
 *
 * Clear/archive/TTL append a redaction marker to the outbox, rewrite this
 * writer's shards so matching lines lose their content/snapshot, and blank the
 * same events in the store; replay applies the markers, so a backfill never
 * writes cleared content back. A filter is registered the moment a redaction
 * is accepted: appends covered by a known marker are written as skeletons, so
 * an in-flight append can never resurrect plaintext after the wipe. Shards
 * are only ever rewritten by the writer that appends to them, so a rewrite
 * never races another node's append;
 * in-process appends and rewrites of a shard are serialized, and whole-scan
 * rewrites are serialized against each other by a global rewrite lock.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { IMemoryStore, MemoryEvent, MemoryEventRedactFilter } from "../store/types.js";
import { createKeyedMutex } from "../../utils/keyed-mutex.js";
import { canonEventBound, canonIsoTs, EVENT_ID_RE, healIsoId, isValidRedactFilter, newMemoryEventId, withMemoryEventId } from "../store/memory-event-id.js";
import type { Logger } from "../types.js";
import { validReview } from "../store/review.js";

/** The store capabilities the ledger needs; health is tracked per store object and tenant. */
export type LedgerStore = Pick<IMemoryStore, "appendMemoryEvent" | "redactMemoryEvents">;

const TAG = "[memory-tdai][event-ledger]";

export interface LedgerHealth {
  store_failures: number;
  jsonl_failures: number;
  last_failure_at?: string;
  /** Events missing from the store: outbox-pending (replayable) plus unrecoverable failures with no outbox copy. */
  pending_store_events: number;
  /**
   * Clear/TTL redactions not fully landed: the store wipe and/or the outbox
   * marker/shard rewrite failed (backfill retries both).
   */
  pending_redactions: number;
  /** Of `pending_redactions`, those whose outbox marker or shard rewrite is still outstanding. */
  pending_outbox_rewrites: number;
  /** Redactions refused by contract validation (bad `until`/filter shape): never applied, nothing to retry. */
  rejected_redactions: number;
}

export interface LedgerAppendResult {
  event_id: string;
  jsonl: boolean;
  store: boolean;
}

export interface LedgerReplayResult {
  files: number;
  scanned: number;
  replayed: number;
  skipped: number;
  malformed: number;
  failed: number;
  /** Replayed events covered by a clear/TTL marker (replayed as content-less skeletons). */
  redacted: number;
  /** Clear/TTL markers re-applied to the store. */
  redactions_applied: number;
  /** Outbox lines blanked in place (pending rewrites retried + owned shards swept against markers). */
  outbox_redacted: number;
  /** Outbox marker appends / shard rewrites that failed again (kept pending). */
  outbox_failed: number;
  /**
   * Event collection stopped at the size cap — rerun with a tighter `since`.
   * Redaction markers are still read from every shard, so the events that
   * were collected are replayed with full marker coverage.
   */
  truncated?: boolean;
}

/** Tenant scope used by health, replay and redaction (unset fields match anything). */
export interface LedgerScope {
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
}

type LedgerLogger = Pick<Logger, "warn"> & Partial<Pick<Logger, "debug">>;

interface RedactionMarker {
  redact: MemoryEventRedactFilter;
  marker_ts: string;
}

const MAX_PENDING_TRACKED = 10_000;
/**
 * A known redaction only guards appends whose event_ts <= until. Every live
 * append stamps event_ts at write time (l1-writer, api mutations, retention),
 * so a filter whose until is older than this horizon can no longer cover a
 * live append — it is safe to forget once its own work has landed. Replay
 * never relies on this set (it applies the outbox markers directly).
 */
const KNOWN_REDACTION_HORIZON_MS = 60 * 60 * 1000;
/** Backfill reads whole shards into memory; cap the total so a huge outbox can't OOM the process. */
const MAX_REPLAY_BYTES = 256 * 1024 * 1024;

interface TenantHealth {
  team_id: string;
  agent_id: string;
  store_failures: number;
  jsonl_failures: number;
  last_failure_at?: string;
  /** event_id → record_id for events written to the outbox but missing from the store. */
  pending: Map<string, string>;
  /** Store failures that cannot be cleared by replay (no outbox copy, or pending overflowed). */
  unrecoverable: number;
  rejected_redactions: number;
}

/**
 * Per-logical-store ledger bookkeeping: tenant health, pending redaction work
 * (each carrying its applied `cleared` dims) and known redaction filters.
 * StorePool recreates store objects on LRU eviction / config change, so pool
 * creation sites register the object under a stable `${backend}:${instanceId}`
 * key and get the same state back; unregistered stores own a private state
 * (standalone: one store per process, eviction cannot orphan anything).
 */
export class LedgerState {
  readonly health = new Map<string, TenantHealth>();
  /** Failed redaction legs keyed by their canonical filter. */
  readonly pendingRedactions = new Map<string, PendingRedaction>();
  /**
   * Redaction filters this process has accepted (pending or landed). Appends
   * covered by a known filter are written as skeletons so a redaction racing an
   * in-flight append can never resurrect plaintext in the store or outbox
   * (fail-closed: the filter is registered before any leg is attempted).
   */
  readonly knownRedactions = new Map<string, MemoryEventRedactFilter>();
  /**
   * Size at which expired known redactions are pruned. Never a hard cap:
   * live (unexpired or still-pending) filters are never evicted — evicting
   * one would let a racing append persist cleared plaintext (fail-open).
   */
  knownRedactionSoftCap = 1_000;

  /** Fold bookkeeping recorded under another state into this one. */
  adopt(other: LedgerState): void {
    for (const [k, v] of other.pendingRedactions) {
      const cur = this.pendingRedactions.get(k);
      if (cur) { // same filter failed under both identities — union the legs
        cur.store ||= v.store; cur.outbox ||= v.outbox; cur.marker ??= v.marker;
        for (const c of v.cleared) cur.cleared.add(c);
      } else this.pendingRedactions.set(k, v);
    }
    for (const [k, v] of other.health) {
      const cur = this.health.get(k);
      if (cur) {
        cur.store_failures += v.store_failures; cur.jsonl_failures += v.jsonl_failures;
        cur.unrecoverable += v.unrecoverable;
        cur.rejected_redactions += v.rejected_redactions;
        for (const [id, rid] of v.pending) cur.pending.set(id, rid);
        if (v.last_failure_at && (!cur.last_failure_at || v.last_failure_at > cur.last_failure_at)) cur.last_failure_at = v.last_failure_at;
      } else this.health.set(k, v);
    }
    for (const [k, v] of other.knownRedactions) {
      const prev = this.knownRedactions.get(k);
      if (!prev || prev.until < v.until) this.knownRedactions.set(k, v);
    }
  }
}

const statesByKey = new Map<string, LedgerState>();
const stateByStore = new WeakMap<object, LedgerState>();
const keyedStates = new WeakSet<LedgerState>();
/** Writes attempted before a store was attached; visible from every store's health. */
const unboundState = new LedgerState();

function stateOf(store: LedgerStore | undefined): LedgerState {
  if (store === undefined) return unboundState;
  let state = stateByStore.get(store);
  if (!state) {
    state = new LedgerState();
    stateByStore.set(store, state);
  }
  return state;
}

/**
 * Attach `store` to the ledger state of logical store `key`, creating it on
 * first use. Bookkeeping recorded under the object before its first
 * registration (early init writes can race the first getStore call) is
 * adopted; another logical store's state is never merged in.
 */
export function registerLedgerState(store: object, key: string): LedgerState {
  let state = statesByKey.get(key);
  if (!state) {
    state = new LedgerState();
    statesByKey.set(key, state);
    keyedStates.add(state);
  }
  const prior = stateByStore.get(store);
  if (prior && !keyedStates.has(prior)) state.adopt(prior);
  stateByStore.set(store, state);
  return state;
}

interface PendingRedaction {
  filter: MemoryEventRedactFilter;
  /** Applied narrowed store-wipes ({team_id?,agent_id?} keys) for filters broader than a scoped backfill. */
  cleared: Set<string>;
  /** The store wipe has not landed. */
  store: boolean;
  /** The outbox shard rewrite has not landed. */
  outbox: boolean;
  /** The outbox marker append failed; retried verbatim. */
  marker?: RedactionMarker;
}

function markPending(
  store: LedgerStore | undefined,
  filter: MemoryEventRedactFilter,
  part: { store?: true; outbox?: true; marker?: RedactionMarker },
): void {
  tenantHealth(store, { team_id: filter.team_id ?? "", agent_id: filter.agent_id ?? "" }).last_failure_at = new Date().toISOString();
  const m = pendingRedactions(store);
  const k = redactionKey(filter);
  let p = m.get(k);
  if (!p) {
    p = { filter, cleared: new Set(), store: false, outbox: false };
    m.set(k, p);
  }
  if (part.store) { p.store = true; p.cleared.clear(); }
  if (part.outbox) p.outbox = true;
  if (part.marker) p.marker = part.marker;
}

function settlePending(m: Map<string, PendingRedaction>, p: PendingRedaction): void {
  if (!p.store && !p.outbox && !p.marker && m.get(redactionKey(p.filter)) === p) m.delete(redactionKey(p.filter));
}

function registerKnownRedaction(store: LedgerStore | undefined, filter: MemoryEventRedactFilter): void {
  // markerCovers compares event_ts <= until lexically — every registered
  // filter must carry a canonical until (defense-in-depth: callers already
  // normalize, but a garbage until must never drive coverage checks).
  const until = canonIsoTs(filter.until);
  if (until === null) return;
  filter = { ...filter, until };
  const m = stateOf(store).knownRedactions;
  // Keyed by tenant dimensions only: a later `until` for the same dimensions
  // subsumes earlier ones, so the map is bounded by distinct scopes rather
  // than by redaction count.
  const k = redactionScopeKey(filter);
  const prev = m.get(k);
  if (prev && prev.until >= until) return;
  if (!prev && m.size >= stateOf(store).knownRedactionSoftCap) pruneKnownRedactions(store);
  m.set(k, filter);
}

/**
 * Drop known redactions that can no longer cover a live append (until older
 * than the horizon) and have no pending work. Amortized: only runs when the
 * map reaches its soft cap. Unexpired filters are kept even past the cap —
 * the set then grows with the redaction rate of one horizon, never fails open.
 */
function pruneKnownRedactions(store: LedgerStore | undefined): void {
  const state = stateOf(store);
  const cutoff = new Date(Date.now() - KNOWN_REDACTION_HORIZON_MS).toISOString();
  const pendingScopes = new Set<string>();
  eachPendingRedaction(store, (_m, p) => pendingScopes.add(redactionScopeKey(p.filter)));
  for (const [k, f] of state.knownRedactions) {
    if (f.until < cutoff && !pendingScopes.has(k)) state.knownRedactions.delete(k);
  }
}

/** Filters (pending or applied) that cover this event — content must not be persisted. */
function coveringRedactions(store: LedgerStore | undefined, event: MemoryEvent): MemoryEventRedactFilter[] {
  return [...stateOf(store).knownRedactions.values()].filter((f) => markerCovers(f, event));
}

function redactionScopeKey(f: MemoryEventRedactFilter): string {
  return JSON.stringify([healIsoId(f.team_id) ?? null, healIsoId(f.agent_id) ?? null, healIsoId(f.user_id) ?? null, f.layer ?? null]);
}

function redactionKey(f: MemoryEventRedactFilter): string {
  return JSON.stringify([f.team_id ?? null, f.agent_id ?? null, f.user_id ?? null, f.layer ?? null, f.until]);
}

function pendingRedactions(store: LedgerStore | undefined): Map<string, PendingRedaction> {
  return stateOf(store).pendingRedactions;
}

/**
 * All pending redactions reachable from `store`: its own bucket plus the
 * unbound state (writes attempted before a store was attached — they still
 * need retries and must show up in health).
 */
function eachPendingRedaction(
  store: LedgerStore | undefined,
  fn: (m: Map<string, PendingRedaction>, p: PendingRedaction) => void,
): void {
  for (const state of [unboundState, stateOf(store)]) {
    const m = state.pendingRedactions;
    for (const p of m.values()) fn(m, p);
  }
}

/** A redaction filter touches the scope when it is not pinned to a different team/agent. */
function redactionTouches(f: MemoryEventRedactFilter, scope?: LedgerScope): boolean {
  return (f.team_id === undefined || scope?.team_id === undefined || f.team_id === scope.team_id) &&
    (f.agent_id === undefined || scope?.agent_id === undefined || f.agent_id === scope.agent_id) &&
    (f.user_id === undefined || scope?.user_id === undefined || f.user_id === scope.user_id);
}

/** Serialized {team_id?,agent_id?} pair of an applied store wipe. */
function clearedDimsKey(teamId?: string, agentId?: string): string {
  return JSON.stringify([teamId ?? null, agentId ?? null]);
}

/** Applied wipe `entry` covers the questioned scope iff it pins no dimension the scope leaves free. */
function clearedCovers(entry: string, scope?: LedgerScope | MemoryEventRedactFilter): boolean {
  const [t, a] = JSON.parse(entry) as [string | null, string | null];
  return (t === null || scope?.team_id === t) && (a === null || scope?.agent_id === a);
}

function storeRedactionPendingFor(p: PendingRedaction, scope?: LedgerScope): boolean {
  if (!p.store || !redactionTouches(p.filter, scope)) return false;
  return ![...p.cleared].some((entry) => clearedCovers(entry, scope));
}

function outboxRedactionPendingFor(p: PendingRedaction, scope?: LedgerScope): boolean {
  return (p.outbox || p.marker !== undefined) && redactionTouches(p.filter, scope);
}

function tenantKey(team: string, agent: string): string {
  return `${team}\u0001${agent}`;
}

function tenantsFor(store: LedgerStore | undefined): Map<string, TenantHealth> {
  return stateOf(store).health;
}

/** Health buckets reachable from `store`: its own plus the unbound state. */
function eachTenantHealth(
  store: LedgerStore | undefined,
  fn: (h: TenantHealth) => void,
): void {
  for (const state of [unboundState, stateOf(store)]) {
    for (const h of state.health.values()) fn(h);
  }
}

function tenantHealth(store: LedgerStore | undefined, event: Pick<MemoryEvent, "team_id" | "agent_id">): TenantHealth {
  const team = event.team_id ?? "";
  const agent = event.agent_id ?? "";
  const tenants = tenantsFor(store);
  const k = tenantKey(team, agent);
  let h = tenants.get(k);
  if (!h) {
    h = { team_id: team, agent_id: agent, store_failures: 0, jsonl_failures: 0, pending: new Map(), unrecoverable: 0, rejected_redactions: 0 };
    tenants.set(k, h);
  }
  return h;
}

/** Scope dims follow the isolation-id contract: a defined "" reads as "default". */
function healScope(scope?: LedgerScope): LedgerScope | undefined {
  if (!scope) return scope;
  return {
    ...scope,
    team_id: healIsoId(scope.team_id),
    agent_id: healIsoId(scope.agent_id),
    user_id: healIsoId(scope.user_id),
  };
}

/** A "" bucket dim is an unscoped (all-tenant) redaction failure and matches every scope. */
function matchingTenants(store: LedgerStore | undefined, scope?: LedgerScope): TenantHealth[] {
  const out: TenantHealth[] = [];
  eachTenantHealth(store, (h) => {
    if ((scope?.team_id === undefined || h.team_id === "" || h.team_id === scope.team_id) &&
        (scope?.agent_id === undefined || h.agent_id === "" || h.agent_id === scope.agent_id)) out.push(h);
  });
  return out;
}

function recordFailure(
  store: LedgerStore | undefined,
  kind: "store" | "jsonl",
  event: MemoryEvent & { event_id: string },
  recoverable: boolean,
): void {
  const h = tenantHealth(store, event);
  if (kind === "store") {
    h.store_failures += 1;
    if (recoverable && h.pending.size < MAX_PENDING_TRACKED) h.pending.set(event.event_id, event.record_id);
    else h.unrecoverable += 1;
  } else {
    h.jsonl_failures += 1;
  }
  h.last_failure_at = new Date().toISOString();
}

/**
 * A redaction refused by the contract checks never ran: its plaintext stays
 * in place with nothing to retry. Count it on the tenant it named so the
 * ledger reports degraded instead of healthy (no event is missing, so it does
 * not establish whether an authoritative transaction committed).
 */
function recordRejectedRedaction(store: LedgerStore | undefined, filter: MemoryEventRedactFilter): void {
  const h = tenantHealth(store, {
    team_id: typeof filter.team_id === "string" ? healIsoId(filter.team_id) : undefined,
    agent_id: typeof filter.agent_id === "string" ? healIsoId(filter.agent_id) : undefined,
  });
  h.rejected_redactions += 1;
  h.last_failure_at = new Date().toISOString();
}

/**
 * Snapshot of this process's ledger health for the given store, restricted to
 * the tenants matching `scope` (a tenant only sees its own failures). Raw
 * backend errors are logged, never returned. `degraded` stays set while
 * events are missing from the store: pending events clear once a backfill
 * replays them; failures without an outbox copy (or beyond the tracking cap)
 * clear only via `resetLedgerHealth` or a restart. Outbox write failures alone
 * do not degrade review data and are reported via `jsonl_failures` only.
 */
export function getLedgerHealth(
  store: LedgerStore | undefined,
  rawScope?: LedgerScope,
): LedgerHealth & { degraded: boolean } {
  const scope = healScope(rawScope);
  let store_failures = 0;
  let jsonl_failures = 0;
  let pending = 0;
  let unrecoverable = 0;
  let rejectedRedactions = 0;
  let last: string | undefined;
  for (const h of matchingTenants(store, scope)) {
    store_failures += h.store_failures;
    jsonl_failures += h.jsonl_failures;
    pending += h.pending.size;
    unrecoverable += h.unrecoverable;
    rejectedRedactions += h.rejected_redactions;
    if (h.last_failure_at && (!last || h.last_failure_at > last)) last = h.last_failure_at;
  }
  const pendingR: PendingRedaction[] = [];
  eachPendingRedaction(store, (_m, p) => pendingR.push(p));
  const redactions = pendingR.filter((p) => storeRedactionPendingFor(p, scope) || outboxRedactionPendingFor(p, scope)).length;
  const outboxRewrites = pendingR.filter((p) => outboxRedactionPendingFor(p, scope)).length;
  return {
    store_failures,
    jsonl_failures,
    ...(last ? { last_failure_at: last } : {}),
    pending_store_events: pending + unrecoverable,
    pending_redactions: redactions,
    pending_outbox_rewrites: outboxRewrites,
    rejected_redactions: rejectedRedactions,
    degraded: pending > 0 || unrecoverable > 0 || redactions > 0 || rejectedRedactions > 0,
  };
}

/**
 * Test/ops hook: clear the failure counters (also the shared unbound state).
 * With a `scope`, only that tenant's buckets are cleared (the HTTP reset
 * path always passes the caller's scope — see handleMemoryLedgerStatus).
 * Pending redactions are deliberately NOT cleared — they are un-applied work,
 * not bookkeeping. Resetting them would let a failed store wipe silently never
 * retry while the ledger reports healthy; they clear only by actually landing
 * (backfill) or process restart.
 */
export function resetLedgerHealth(store: LedgerStore | undefined, rawScope?: LedgerScope): void {
  const states = store !== undefined ? [stateOf(store), unboundState] : [stateOf(store)];
  const scope = healScope(rawScope);
  if (scope?.team_id === undefined && scope?.agent_id === undefined) {
    // Unscoped (ops / tests): clear every tenant bucket.
    for (const state of states) state.health.clear();
    return;
  }
  // Tenant-scoped reset: only the caller's own buckets. The unscoped ("")
  // buckets hold all-tenant failures (e.g. a rejected TTL redaction) that
  // every tenant sees — one tenant must not be able to clear them, nor any
  // other tenant's counters.
  for (const state of states) {
    for (const [k, h] of state.health) {
      if ((scope.team_id === undefined || h.team_id === scope.team_id) &&
          (scope.agent_id === undefined || h.agent_id === scope.agent_id) &&
          h.team_id !== "" && h.agent_id !== "") state.health.delete(k);
    }
  }
}

/**
 * Shard date of a canonical instant. Every caller passes a timestamp already
 * validated by canonIsoTs (append) or isValidRedactFilter (redact), so an
 * invalid one is a programming error — throw rather than silently filing the
 * line under "today".
 */
function shardDateOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`${TAG} shardDateOf: invalid instant "${ts}"`);
  return d.toISOString().slice(0, 10);
}

// ── Outbox shards ──
//
//   events/YYYY-MM-DD.jsonl                  no writer id configured
//   events/YYYY-MM-DD.<writerId>.jsonl       live shard this writer appends to
//   events/YYYY-MM-DD[.<writerId>]~<gen>.jsonl  sealed shard produced by a rewrite
//
// A rewrite never overwrites an object in place (COS appendable objects cannot
// be overwritten): it creates a fresh sealed shard with the redacted content,
// then deletes the old one. Later appends recreate the live shard.

const WRITER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHARD_RE = /^(\d{4}-\d{2}-\d{2})(?:\.([A-Za-z0-9_-]{1,64}))?(?:~([a-z0-9]{1,32}))?\.jsonl$/;

let ledgerWriterId: string | undefined = newLedgerWriterId();

/**
 * Set this process's outbox writer id (stable per node/boot). New events go
 * to `events/YYYY-MM-DD.<writerId>.jsonl`; rewrites only touch shards with
 * this suffix. `undefined` restores the single-writer naming.
 */
export function setLedgerWriterId(id: string | undefined): void {
  if (id !== undefined && !WRITER_ID_RE.test(id)) throw new Error(`invalid ledger writer id: ${JSON.stringify(id)}`);
  ledgerWriterId = id;
}

export function getLedgerWriterId(): string | undefined {
  return ledgerWriterId;
}

/** A fresh writer id: `<host>-<8 hex>`. */
export function newLedgerWriterId(): string {
  const host = hostname().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "node";
  return `${host}-${randomBytes(4).toString("hex")}`;
}

const WRITER_ID_FILE = join(".metadata", "ledger_writer_id");

/**
 * Adopt the writer id persisted in `dataDir` (created on first use), so a
 * restarted process keeps owning — and can still rewrite — the shards it
 * wrote before. One writer process per data dir is assumed. Falls back to
 * the per-boot id already in effect when the file cannot be read or written.
 */
export function loadLedgerWriterId(dataDir: string, logger?: LedgerLogger): string | undefined {
  const file = join(dataDir, WRITER_ID_FILE);
  try {
    const existing = readFileSync(file, "utf-8").trim();
    if (WRITER_ID_RE.test(existing)) {
      ledgerWriterId = existing;
      return ledgerWriterId;
    }
  } catch {
    // not created yet
  }
  const id = newLedgerWriterId();
  try {
    mkdirSync(join(dataDir, ".metadata"), { recursive: true });
    writeFileSync(file, id, "utf-8");
    ledgerWriterId = id;
  } catch (err) {
    logger?.warn?.(`${TAG} cannot persist outbox writer id (using per-boot ${ledgerWriterId}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return ledgerWriterId;
}

interface ShardName {
  name: string;
  date: string;
  writer?: string;
}

export function parseLedgerShardName(name: string): ShardName | undefined {
  const m = SHARD_RE.exec(name);
  return m ? { name, date: m[1]!, ...(m[2] ? { writer: m[2] } : {}) } : undefined;
}

/** Shards this process may rewrite: only the ones it appends to. */
function ownsShard(s: ShardName): boolean {
  return s.writer === ledgerWriterId;
}

async function listShards(storage: StorageAdapter): Promise<ShardName[]> {
  const shards: ShardName[] = [];
  let marker: string | undefined;
  do {
    const page = await storage.readdirPage(StoragePaths.eventsDir, { suffix: ".jsonl", maxKeys: 1000, marker });
    for (const entry of page.entries) {
      if (entry.isDirectory) continue;
      const name = entry.key.startsWith(StoragePaths.eventsDir) ? entry.key.slice(StoragePaths.eventsDir.length) : entry.key;
      const shard = parseLedgerShardName(name);
      if (shard) shards.push(shard);
    }
    marker = page.nextMarker;
  } while (marker !== undefined);
  return shards.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sealedShardKey(s: ShardName): string {
  const gen = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  return `${StoragePaths.eventsDir}${s.date}${s.writer ? `.${s.writer}` : ""}~${gen}.jsonl`;
}

/** Per-shard FIFO: appends and rewrites of the same key never interleave within this process. */
const withShardLock = createKeyedMutex();

async function appendToLiveShard(storage: StorageAdapter, ts: string, line: string): Promise<void> {
  const key = StoragePaths.eventShard(shardDateOf(ts), ledgerWriterId);
  await withShardLock(key, () => storage.appendFile(key, line));
}

/**
 * Blank content/snapshot_json of event lines covered by any filter; marker
 * lines, malformed lines and uncovered events are kept byte-for-byte.
 */
function redactOutboxContent(content: string, filters: readonly MemoryEventRedactFilter[]): { content: string; lines: number } {
  let lines = 0;
  const out = content.split("\n").map((line) => {
    if (!line.trim()) return line;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return line;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return line;
    const e = value as MemoryEvent & Partial<RedactionMarker>;
    if (e.redact !== undefined || typeof e.event_ts !== "string") return line;
    const hasPlaintext = (e.content !== undefined && e.content !== null && e.content !== "") ||
      (e.snapshot_json !== undefined && e.snapshot_json !== null && e.snapshot_json !== "") || Boolean(e.reason);
    if (!hasPlaintext || !filters.some((f) => markerCovers(f, e))) return line;
    lines += 1;
    const { snapshot_json: _dropped, reason: _reason, ...skeleton } = e;
    return JSON.stringify({ ...skeleton, content: "" });
  });
  return { content: out.join("\n"), lines };
}

/**
 * Serializes whole-scan rewrites against each other. Two concurrent
 * `redactLedgerEvents` must not both snapshot the shard list: the loser would
 * read null on the freshly-sealed-away live shard and report success while
 * the sealed copy still holds its plaintext. The key can never collide with a
 * shard key (shard names match SHARD_RE).
 */
const REWRITE_LOCK_KEY = `${StoragePaths.eventsDir}#rewrite-all`;

/**
 * Rewrite the owned shards that may hold events covered by `filters`
 * (shard date ≤ the latest `until`). The shard list is re-read under the
 * global rewrite lock so sealed generations produced by a just-finished
 * redaction are visible. `only` limits the scan to shard families
 * ("date\0writer" keys) rather than names, so a shard sealed between listing
 * and rewriting is still swept via its newest generation.
 * Each shard rewrite runs under its own lock: re-read, append the sealed
 * copy to a fresh ~gen key, delete the original. Sealed shards are written
 * via appendObject (not putObject) so every object under events/ stays
 * append-created — a uniform access pattern that COS APPENDABLE_KEY_PREFIXES
 * guards can never reject. The sealed copy is never the sole copy until the
 * append resolves (unlink is strictly after), so a reader seeing it
 * mid-append loses nothing. Throws after trying every shard if any rewrite
 * failed.
 */
async function rewriteOutboxShards(
  storage: StorageAdapter,
  filters: readonly MemoryEventRedactFilter[],
  only?: ReadonlySet<string>,
): Promise<number> {
  if (filters.length === 0) return 0;
  return withShardLock(REWRITE_LOCK_KEY, async () => {
    const maxDate = filters.map((f) => shardDateOf(f.until)).sort().at(-1)!;
    const shards = (await listShards(storage)).filter((s) =>
      ownsShard(s) && s.date <= maxDate && (!only || only.has(`${s.date}\u0000${s.writer ?? ""}`)));
    let lines = 0;
    let firstErr: unknown;
    for (const s of shards) {
      const key = `${StoragePaths.eventsDir}${s.name}`;
      try {
        lines += await withShardLock(key, async () => {
          const content = await storage.readFile(key);
          if (content === null) return 0;
          const r = redactOutboxContent(content, filters);
          if (r.lines === 0) return 0;
          await storage.appendFile(sealedShardKey(s), r.content);
          await storage.unlink(key);
          return r.lines;
        });
      } catch (err) {
        firstErr ??= err;
      }
    }
    if (firstErr !== undefined) throw firstErr;
    return lines;
  });
}

export async function appendLedgerEvent(params: {
  store: LedgerStore | undefined;
  storage?: StorageAdapter;
  event: MemoryEvent;
  storeAlreadyCommitted?: boolean;
  logger?: LedgerLogger;
}): Promise<LedgerAppendResult> {
  const { store, storage, logger } = params;
  let event = withMemoryEventId(params.event);
  // A caller-supplied id outside the contract shape is re-minted rather than
  // persisted — a malformed id must not enter dedup space.
  if (!EVENT_ID_RE.test(event.event_id)) {
    logger?.warn?.(
      `${TAG} append: malformed event_id "${event.event_id}" re-minted record_id=${event.record_id}`,
    );
    event = { ...event, event_id: newMemoryEventId() };
  }
  // event_ts is compared lexically everywhere (queries, markers, replay) —
  // enforce the canonical ms form at ingest rather than trusting callers.
  // A timestamp that cannot be losslessly represented is rejected loudly.
  const eventTs = canonIsoTs(event.event_ts);
  if (eventTs === null) {
    logger?.warn?.(
      `${TAG} append rejected: event_ts "${event.event_ts}" is not a millisecond-exact ISO instant ` +
      `event_id=${event.event_id} record_id=${event.record_id}`,
    );
    // The event is missing from both legs and backfill cannot restore it:
    // surface it as an unrecoverable store gap rather than a silent drop.
    recordFailure(store, "store", {
      ...event,
      team_id: healIsoId(event.team_id ?? ""),
      agent_id: healIsoId(event.agent_id ?? ""),
    }, false);
    return { event_id: event.event_id, jsonl: false, store: false };
  }
  // Isolation ids converge on the record-store form: "default" for
  // team/user/agent (matching upsert bindings and resolveIsolation),
  // undefined for task — never ""/missing/"default" for the same logical
  // "no value". Coverage, scope and query filters all compare by equality.
  event = {
    ...event,
    event_ts: eventTs,
    team_id: healIsoId(event.team_id ?? ""),
    agent_id: healIsoId(event.agent_id ?? ""),
    user_id: healIsoId(event.user_id ?? ""),
    task_id: event.task_id || undefined,
  };
  // Redaction race guard: an append that lands after a clear/TTL must never
  // persist plaintext — not in the outbox (a rewrite may have already swept
  // that shard) and not in the store (its wipe already ran). Events covered by
  // any known marker are appended as content-less skeletons instead.
  if (coveringRedactions(store, event).length > 0) {
    event = { ...event, content: "", snapshot_json: undefined, reason: undefined };
  }
  const result: LedgerAppendResult = { event_id: event.event_id, jsonl: false, store: false };

  if (storage) {
    try {
      // Re-check coverage *inside* the shard lock: a redaction that registered
      // after the top-of-function check but before this append's slot in the
      // queue must not leave plaintext on disk either. Both orderings converge:
      // append-then-rewrite → the rewrite skeletonizes the line; rewrite-then-
      // append → the locked re-check skeletonizes the event before it lands.
      const key = StoragePaths.eventShard(shardDateOf(event.event_ts), ledgerWriterId);
      await withShardLock(key, async () => {
        if (coveringRedactions(store, event).length > 0) {
          event = { ...event, content: "", snapshot_json: undefined, reason: undefined };
        }
        await storage.appendFile(key, JSON.stringify(event) + "\n");
      });
      result.jsonl = true;
    } catch (err) {
      recordFailure(store, "jsonl", event, false);
      logger?.warn?.(
        `${TAG} outbox append failed (non-fatal) event_id=${event.event_id} record_id=${event.record_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(`${TAG} outbox skipped: no storage adapter (event_id=${event.event_id})`);
  }

  if (store?.appendMemoryEvent) {
    let storeErr: unknown;
    try {
      if (!params.storeAlreadyCommitted) await store.appendMemoryEvent(event);
      result.store = true;
    } catch (err) {
      storeErr = err;
    }
    // Late-marker convergence: a clear/TTL may have registered while our
    // insert was in flight, letting the row slip past its filter-update. The
    // outbox side is already sealed (per-writer shard lock), so a covered
    // append reaching this point with plaintext (content or snapshot — a
    // superseded/management-update event may carry snapshot_json with empty
    // content) means the store leg missed it — re-apply the covering
    // markers' filter-update ourselves. Idempotent, and failures are tracked
    // as pending store redactions.
    if (storeErr === undefined && (event.content !== "" || event.snapshot_json || event.reason)) {
      for (const m of coveringRedactions(store, event)) {
        try {
          await store.redactMemoryEvents?.(m);
        } catch (err) {
          storeErr = err;
          markPending(store, m, { store: true });
          logger?.warn?.(
            `${TAG} post-append redact retry failed event_id=${event.event_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (storeErr !== undefined) {
      recordFailure(store, "store", event, result.jsonl);
      logger?.warn?.(
        `${TAG} store append failed (non-fatal${result.jsonl ? ", recoverable via backfill" : ""}) ` +
        `event_id=${event.event_id} record_id=${event.record_id} op=${event.op}: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
      );
    }
  }
  return result;
}

/**
 * Blank content/snapshot of the events matching `filter` (clear/archive/TTL):
 * appends a redaction marker to the outbox (so replay honours it), rewrites
 * the owned outbox shards so matching lines lose their plaintext, and redacts
 * the store. Best-effort, never throws: any part that fails is tracked in
 * `pending_redactions` (ledger degraded) and retried by backfill.
 */
export async function redactLedgerEvents(params: {
  store: LedgerStore | undefined;
  storage?: StorageAdapter;
  filter: MemoryEventRedactFilter;
  logger?: LedgerLogger;
}): Promise<{ jsonl: boolean; rewritten?: number; redacted?: number }> {
  const { store, storage, logger } = params;
  // The marker's until drives lexical coverage checks everywhere — normalize
  // to canonical form once so the outbox marker, registered filter and store
  // call all carry the same bound. An unrepresentable until is rejected.
  const until = canonIsoTs(params.filter.until);
  if (until === null) {
    logger?.warn?.(`${TAG} redaction rejected: until "${params.filter.until}" is not a millisecond-exact ISO instant`);
    recordRejectedRedaction(store, params.filter);
    return { jsonl: false };
  }
  // "" ids heal to "default" on defined fields — the marker written to the
  // outbox, the registered coverage filter and the store wipe must all
  // agree on the same logical scope (undefined stays unconstrained).
  const filter: MemoryEventRedactFilter = {
    ...params.filter,
    until,
    team_id: healIsoId(params.filter.team_id),
    agent_id: healIsoId(params.filter.agent_id),
    user_id: healIsoId(params.filter.user_id),
  };
  // The same whitelist that guards on-disk markers guards the write path: a
  // filter carrying fields outside {team_id,agent_id,user_id,until} (e.g. a
  // task_id smuggled past the type) is silently dropped by coverage and the
  // stores — erasing wider than claimed AND writing a marker replay would
  // reject (plaintext then re-appends = un-redaction). Refuse outright.
  if (!isValidRedactFilter(filter)) {
    logger?.warn?.(`${TAG} redaction rejected: filter carries fields outside {team_id,agent_id,user_id,layer,until}`);
    recordRejectedRedaction(store, params.filter);
    return { jsonl: false };
  }
  const out: { jsonl: boolean; rewritten?: number; redacted?: number } = { jsonl: false };
  // Register before any leg runs: appends covered by this filter must
  // skeletonize even while (or if) the marker/rewrite/store legs below fail.
  registerKnownRedaction(store, filter);
  if (storage) {
    const marker: RedactionMarker = { redact: filter, marker_ts: new Date().toISOString() };
    try {
      await appendToLiveShard(storage, marker.marker_ts, JSON.stringify(marker) + "\n");
      out.jsonl = true;
    } catch (err) {
      markPending(store, filter, { marker });
      logger?.warn?.(`${TAG} redaction marker append failed (non-fatal, retried by backfill): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      out.rewritten = await rewriteOutboxShards(storage, [filter]);
    } catch (err) {
      markPending(store, filter, { outbox: true });
      logger?.warn?.(`${TAG} outbox shard rewrite failed (non-fatal, retried by backfill): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (store?.redactMemoryEvents) {
    try {
      out.redacted = await store.redactMemoryEvents(filter);
    } catch (err) {
      markPending(store, filter, { store: true });
      logger?.warn?.(
        `${TAG} store redaction failed (non-fatal${out.jsonl ? ", re-applied by backfill" : ""}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Retry outbox markers / shard rewrites that failed when the redaction ran. */
async function retryPendingOutbox(
  store: LedgerStore,
  storage: StorageAdapter,
  out: LedgerReplayResult,
  logger?: LedgerLogger,
): Promise<void> {
  const pending: Array<{ m: Map<string, PendingRedaction>; p: PendingRedaction }> = [];
  eachPendingRedaction(store, (m, p) => pending.push({ m, p }));
  for (const { m, p } of pending) {
    if (p.marker) {
      try {
        await appendToLiveShard(storage, p.marker.marker_ts, JSON.stringify(p.marker) + "\n");
        p.marker = undefined;
      } catch (err) {
        out.outbox_failed += 1;
        logger?.warn?.(`${TAG} replay: redaction marker retry failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (p.outbox) {
      try {
        out.outbox_redacted += await rewriteOutboxShards(storage, [p.filter]);
        p.outbox = false;
      } catch (err) {
        out.outbox_failed += 1;
        logger?.warn?.(`${TAG} replay: outbox shard rewrite retry failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    settlePending(m, p);
  }
}

const MEMORY_EVENT_OPS: ReadonlySet<string> = new Set<MemoryEvent["op"]>(
  ["created", "updated", "merged", "superseded", "reverted", "deleted", "retracted", "restored"],
);

function isReplayableEvent(e: Partial<Record<keyof MemoryEvent, unknown>>): e is MemoryEvent {
  return typeof e.event_id === "string" && EVENT_ID_RE.test(e.event_id) &&
    typeof e.record_id === "string" && e.record_id !== "" &&
    typeof e.op === "string" && MEMORY_EVENT_OPS.has(e.op) &&
    typeof e.event_ts === "string" && canonIsoTs(e.event_ts) !== null &&
    typeof e.content === "string" &&
    (e.review === undefined || validReview(e.review)) &&
    (e.version === undefined || typeof e.version === "number") &&
    (e.supersedes === undefined || (Array.isArray(e.supersedes) && e.supersedes.every((s) => typeof s === "string"))) &&
    OPTIONAL_STRING_FIELDS.every((k) => e[k] === undefined || typeof e[k] === "string");
}

// Backends coerce non-string values (sqlite stores 123 as "123.0"), which would
// silently change tenant identity or persist non-string plaintext.
const OPTIONAL_STRING_FIELDS = [
  "session_key", "session_id", "origin_session_id", "origin_session_key",
  "team_id", "user_id", "agent_id", "task_id", "reviewer_id", "memory_type",
  "superseded_by", "snapshot_json", "layer", "source", "request_id", "reason",
  "target_event_id", "scope", "until",
] as const satisfies readonly (keyof MemoryEvent)[];

/**
 * A marker line is trusted to drive store wipes — validated by the shared
 * isValidRedactFilter whitelist (see memory-event-id.ts). A forged/garbage
 * marker — e.g. one smuggling a `task_id` coverage ignores — could otherwise
 * widen a store wipe across tenants.
 */

function markerCovers(m: MemoryEventRedactFilter, e: MemoryEvent): boolean {
  // Legacy rows may still carry ""/missing ids — read them through the same
  // normalization writes use ("default") so coverage is form-independent.
  const tenantMatch =
    (m.team_id === undefined || healIsoId(e.team_id ?? "") === healIsoId(m.team_id)) &&
    (m.agent_id === undefined || healIsoId(e.agent_id ?? "") === healIsoId(m.agent_id)) &&
    (m.user_id === undefined || healIsoId(e.user_id ?? "") === healIsoId(m.user_id)) &&
    // Layer-scoped markers (L1 TTL) leave other layers' events alone; rows
    // without a layer are legacy L1.
    (m.layer === undefined || (e.layer ?? "l1") === m.layer);
  // Compare canonical instants: a foreign-writer line may carry `+08:00` or
  // omitted-millis event_ts that lexically escapes a canonical until. An
  // unevaluable timestamp is treated as in-window — a corrupt ts must not
  // shield plaintext from a tenant-scoped wipe.
  const ets = canonIsoTs(e.event_ts);
  return tenantMatch && (ets === null || ets <= m.until);
}

function inScope(scope: LedgerScope | undefined, e: MemoryEvent): boolean {
  // Same legacy-form healing as markerCovers, on BOTH sides: ""/missing ids
  // read as the write-side normalization target ("default"; task stays bare).
  return (scope?.team_id === undefined || healIsoId(e.team_id ?? "") === healIsoId(scope.team_id)) &&
    (scope?.agent_id === undefined || healIsoId(e.agent_id ?? "") === healIsoId(scope.agent_id)) &&
    (scope?.user_id === undefined || healIsoId(e.user_id ?? "") === healIsoId(scope.user_id)) &&
    (scope?.task_id === undefined || (e.task_id ?? "") === scope.task_id);
}

/**
 * Re-apply outbox events to the store. Idempotent: events already present
 * (same event_id) are no-ops on every backend. Pending outbox rewrites are
 * retried first; redaction markers found in the scanned shards (from every
 * writer) are then applied to the store and to this writer's own scanned
 * shards, so cleared content is never restored and converges out of the outbox.
 */
export async function replayLedgerEvents(params: {
  store: LedgerStore;
  storage: StorageAdapter;
  /** Only replay shards dated on/after this ISO timestamp (and events at/after it). */
  since?: string;
  scope?: LedgerScope;
  logger?: LedgerLogger;
  /** Event-collection memory cap (default MAX_REPLAY_BYTES); test hook. */
  maxScanBytes?: number;
}): Promise<LedgerReplayResult> {
  const { store, storage, logger } = params;
  const maxScanBytes = params.maxScanBytes ?? MAX_REPLAY_BYTES;
  const scope = healScope(params.scope);
  // Compared lexically against canonical event_ts below — canonicalize first.
  const since = params.since === undefined ? undefined : canonEventBound(params.since);
  const out: LedgerReplayResult = {
    files: 0, scanned: 0, replayed: 0, skipped: 0, malformed: 0, failed: 0, redacted: 0, redactions_applied: 0,
    outbox_redacted: 0, outbox_failed: 0,
  };
  await retryPendingOutbox(store, storage, out, logger);
  if (!store.appendMemoryEvent) return out;

  const sinceDate = since ? new Date(since).toISOString().slice(0, 10) : undefined;
  const shards = (await listShards(storage)).filter((s) => !sinceDate || s.date >= sinceDate);

  const events: MemoryEvent[] = [];
  const markersByKey = new Map<string, MemoryEventRedactFilter>();
  const ownedContent = new Map<string, string>();
  let scanBytes = 0;
  /**
   * Latest date of a shard we could not read. A marker lives in the shard of
   * its `marker_ts` and only covers events with `event_ts <= until <=
   * marker_ts` (all current callers bind `until` to the wipe moment — no
   * future-until markers exist; if one ever does, later-dated covered events
   * would slip this guard), so an unreadable shard dated D may hide a marker
   * for any event dated <= D: those events are held back (kept pending)
   * instead of being replayed with possibly-cleared plaintext.
   */
  let unreadableUpTo: string | undefined;
  /** Parse one marker line; malformed markers are counted and ignored. */
  const takeMarker = (parsed: Partial<RedactionMarker>): void => {
    // A redact object that fails validation must not silently act as an
    // event; it is not replayable either way — count it malformed.
    if (!isValidRedactFilter(parsed.redact)) {
      out.malformed += 1;
      return;
    }
    // Normalize the bound: markerCovers compares event_ts <= until
    // lexically, so a foreign writer's `+08:00`/`…ssZ` until would
    // mis-cover (or a garbage one would cover everything). Defined
    // "" ids heal to "default" for the same reason (see healIsoId).
    const redact = parsed.redact;
    redact.until = canonIsoTs(redact.until)!;
    redact.team_id = healIsoId(redact.team_id);
    redact.agent_id = healIsoId(redact.agent_id);
    redact.user_id = healIsoId(redact.user_id);
    markersByKey.set(redactionKey(redact), redact);
  };
  for (const shard of shards) {
    let content: string | null = null;
    try {
      content = await storage.readFile(`${StoragePaths.eventsDir}${shard.name}`);
    } catch (err) {
      // A single unreadable shard must not abort the whole backfill — count it
      // as a failure and keep scanning the rest.
      out.failed += 1;
      if (!unreadableUpTo || shard.date > unreadableUpTo) unreadableUpTo = shard.date;
      logger?.warn?.(`${TAG} replay: shard ${shard.name} read failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (content === null) continue;
    out.files += 1;
    scanBytes += content.length;
    if (!out.truncated && scanBytes > maxScanBytes) {
      out.truncated = true;
      logger?.warn?.(`${TAG} replay: event scan truncated at ${maxScanBytes} bytes — rerun with a tighter 'since' (markers are still collected from every shard)`);
    }
    if (out.truncated) {
      // Past the cap: stop collecting events (memory bound) but keep reading
      // redaction markers from every remaining shard. Markers are written
      // AFTER the events they cover, i.e. into later shards — stopping the
      // scan here would replay already-collected events without them and
      // resurrect cleared plaintext. Content is transient per shard.
      for (const line of content.split("\n")) {
        if (!line.includes('"redact"')) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as Partial<RedactionMarker>).redact !== undefined) {
          takeMarker(value as Partial<RedactionMarker>);
        }
      }
      continue;
    }
    if (ownsShard(shard)) ownedContent.set(shard.name, content);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      out.scanned += 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        out.malformed += 1;
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        out.malformed += 1;
        continue;
      }
      const parsed = value as MemoryEvent & Partial<RedactionMarker>;
      if (parsed.redact !== undefined) {
        takeMarker(parsed);
        continue;
      }
      if (!isReplayableEvent(parsed)) {
        out.malformed += 1;
        continue;
      }
      // Normalize event_ts to the canonical ms form so store rows, sorting
      // and the `since` compare all share the one lexical-safe shape —
      // foreign/outdated writer forms (+08:00, omitted millis) keep their
      // instant, and lossy forms never reach the store. Isolation ids get
      // the same healing: legacy ""/missing forms converge on the write
      // contract ("default"/undefined) so scope filters see them uniformly.
      events.push({
        ...parsed,
        event_ts: canonIsoTs(parsed.event_ts)!,
        team_id: healIsoId(parsed.team_id ?? ""),
        agent_id: healIsoId(parsed.agent_id ?? ""),
        user_id: healIsoId(parsed.user_id ?? ""),
        task_id: parsed.task_id || undefined,
      });
    }
  }
  const markers = [...markersByKey.values()];
  // Markers seen in the outbox also guard subsequent appends (this or other
  // writers' shards may still carry plaintext; new covered appends skeletonize).
  for (const m of markers) registerKnownRedaction(store, m);

  // Re-apply clear/TTL redactions to the store first (idempotent): a redaction
  // the store missed when it ran must not leave cleared content behind.
  // Markers are narrowed to the requested scope so a tenant backfill never
  // touches other tenants' events. In-process pending filters merge in even
  // when their marker's shard is outside the `since` window.
  const pendingMarkers: Array<{ m: Map<string, PendingRedaction>; p: PendingRedaction }> = [];
  eachPendingRedaction(store, (m, p) => pendingMarkers.push({ m, p }));
  for (const { p } of pendingMarkers) {
    if (p.store && !markersByKey.has(redactionKey(p.filter))) {
      markersByKey.set(redactionKey(p.filter), p.filter);
      markers.push(p.filter);
    }
  }

  // Sweep this writer's scanned shards against every marker seen (markers may
  // come from other writers), so their plaintext converges out of the outbox.
  const dirty = new Set<string>();
  /** Only markers that actually cover plaintext in an owned shard become pending if the sweep fails. */
  const dirtyMarkers = new Set<MemoryEventRedactFilter>();
  for (const [n, c] of ownedContent) {
    if (redactOutboxContent(c, markers).lines === 0) continue;
    const covering = markers.filter((m) => redactOutboxContent(c, [m]).lines > 0);
    const s = parseLedgerShardName(n)!;
    dirty.add(`${s.date}\u0000${s.writer ?? ""}`);
    for (const m of covering) dirtyMarkers.add(m);
  }
  if (dirty.size > 0) {
    try {
      out.outbox_redacted += await rewriteOutboxShards(storage, markers, dirty);
    } catch (err) {
      out.outbox_failed += 1;
      for (const filter of dirtyMarkers) markPending(store, filter, { outbox: true });
      logger?.warn?.(`${TAG} replay: outbox sweep rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (store.redactMemoryEvents) {
    for (const m of markers) {
      if (!redactionTouches(m, scope)) continue;
      const narrowed: MemoryEventRedactFilter = {
        ...m,
        ...(m.team_id === undefined && scope?.team_id !== undefined ? { team_id: scope.team_id } : {}),
        ...(m.agent_id === undefined && scope?.agent_id !== undefined ? { agent_id: scope.agent_id } : {}),
      };
      try {
        await store.redactMemoryEvents(narrowed);
        out.redactions_applied += 1;
        // Record the applied wipe by its narrowed team/agent dims: the pending
        // settles when some applied wipe covers the whole filter; scopes fully
        // inside an applied wipe stop reporting pending for the store leg.
        const appliedKey = clearedDimsKey(narrowed.team_id, narrowed.agent_id);
        for (const { m: pm, p } of pendingMarkers) {
          if (redactionKey(p.filter) !== redactionKey(m) || !p.store) continue;
          p.cleared.add(appliedKey);
          if (clearedCovers(appliedKey, p.filter)) {
            p.store = false;
            settlePending(pm, p);
          }
        }
      } catch (err) {
        out.failed += 1;
        logger?.warn?.(`${TAG} replay redaction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const pendingByTenant = new Map<string, TenantHealth>();
  eachTenantHealth(store, (h) => pendingByTenant.set(tenantKey(h.team_id, h.agent_id), h));

  // Rewrites move lines into sealed shards, so file order is not event order.
  events.sort((a, b) => (a.event_ts < b.event_ts ? -1 : a.event_ts > b.event_ts ? 1 : 0));
  for (const raw of events) {
    if ((since && raw.event_ts < since) || !inScope(scope, raw)) {
      out.skipped += 1;
      continue;
    }
    if (unreadableUpTo !== undefined && raw.event_ts.slice(0, 10) <= unreadableUpTo) {
      // An unreadable shard may hold a marker covering this event — keep it
      // pending rather than risk replaying cleared plaintext.
      out.failed += 1;
      continue;
    }
    let event = raw;
    if (markers.some((m) => markerCovers(m, raw))) {
      event = { ...raw, content: "", snapshot_json: undefined, reason: undefined };
      out.redacted += 1;
    }
    try {
      await store.appendMemoryEvent(event);
      out.replayed += 1;
      pendingByTenant.get(tenantKey(event.team_id ?? "", event.agent_id ?? ""))?.pending.delete(event.event_id!);
    } catch (err) {
      out.failed += 1;
      logger?.warn?.(
        `${TAG} replay failed event_id=${event.event_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** A running outbox-retention loop (see startLedgerOutboxRetention). */
export interface LedgerOutboxRetention {
  /** Run one prune pass now; resolves to the number of deleted shards. */
  runOnce(): Promise<number>;
  stop(): void;
}

/**
 * Periodically prune outbox shards older than `retentionDays` (UTC dates,
 * matching shard naming). For hosts without MemoryCleaner (the gateway):
 * without it `events/` grows forever. Runs once immediately, then every
 * `intervalMs` (default 6h); the timer is unref'd so it never holds the
 * process open. Failures are logged and retried on the next tick.
 */
export function startLedgerOutboxRetention(params: {
  getStorage: () => StorageAdapter | undefined;
  retentionDays: number;
  logger?: LedgerLogger & Partial<Pick<Logger, "info">>;
  intervalMs?: number;
  now?: () => number;
}): LedgerOutboxRetention {
  const { getStorage, retentionDays, logger } = params;
  const now = params.now ?? Date.now;
  let running: Promise<number> | undefined;
  const runOnce = (): Promise<number> => {
    if (running) return running;
    running = (async () => {
      const storage = getStorage();
      if (!storage) return 0;
      const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
      try {
        const n = await pruneLedgerOutbox(storage, cutoff);
        if (n > 0) logger?.info?.(`${TAG} outbox retention: pruned ${n} shard(s) dated before ${cutoff}`);
        return n;
      } catch (err) {
        logger?.warn?.(`${TAG} outbox retention failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, params.intervalMs ?? 6 * 3_600_000);
  timer.unref?.();
  return { runOnce, stop: () => clearInterval(timer) };
}

/**
 * Delete outbox shards dated strictly before `beforeDate` (YYYY-MM-DD, UTC —
 * shard names are UTC-dated). Each unlink holds the shard lock so a pruned
 * file can't eat an in-flight append in this process. Returns deleted count.
 */
export async function pruneLedgerOutbox(storage: StorageAdapter, beforeDate: string): Promise<number> {
  const names = (await listShards(storage)).filter((s) => s.date < beforeDate).map((s) => s.name);
  let deleted = 0;
  for (const name of names) {
    const key = `${StoragePaths.eventsDir}${name}`;
    try {
      await withShardLock(key, () => storage.unlink(key));
      deleted += 1;
    } catch { /* already gone / backend hiccup — prune is best-effort */ }
  }
  return deleted;
}
