import { createHash } from "node:crypto";
import { MEMORY_EVENT_HISTORY_LIMIT, type IMemoryStore, type L1RecordRow, type MemoryEvent, type MemoryEventFilter, type MaybePromise } from "./types.js";
import type { IsolationFilter } from "./isolation.js";
import { newMemoryEventId, healIsoId, canonIsoTs } from "./memory-event-id.js";
import { normalizeReviewStatus, type ReviewStatus } from "./visibility.js";

const MAX_NODES = 50_000;
const MAX_EVENTS = 500_000;
const PAGE = 1000;
const BATCH = 50;
const bytes = new WeakMap<MemoryEvent[], number>();
function appendPage(target: MemoryEvent[], page: MemoryEvent[]): void {
  const size = (bytes.get(target) ?? 0) + page.reduce((n, e) => n + JSON.stringify(e).length * 2, 0);
  if (size > 64 * 1024 * 1024 || target.length + page.length > MAX_EVENTS) throw new Error("Review history memory budget exceeded");
  bytes.set(target, size);
  target.push(...page);
}
type Operation = { operation_id?: string; request_id?: string; reviewer_id?: string; reason?: string };
type Node = { id: string; scope: { team_id: string; user_id: string; agent_id: string }; row?: L1RecordRow; events: MemoryEvent[]; loaded: boolean };

export function validReview(value: unknown): value is NonNullable<MemoryEvent["review"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.protocol === 2 && Object.keys(v).every((k) => ["protocol", "observed", "sources", "operation_id", "request_hash", "no_op", "previous_status", "missing", "content_hash", "fence_hash", "guard_at", "guard_epoch"].includes(k)) &&
    (v.guard_epoch === undefined || (typeof v.guard_epoch === "number" && Number.isSafeInteger(v.guard_epoch) && v.guard_epoch >= 0)) &&
    (v.previous_status === undefined || v.previous_status === "active" || v.previous_status === "quarantined") &&
    ((v.operation_id === undefined && v.request_hash === undefined) || (typeof v.operation_id === "string" && typeof v.request_hash === "string")) &&
    (v.guard_at === undefined || (typeof v.guard_at === "string" && canonIsoTs(v.guard_at) === v.guard_at)) &&
    (v.fence_hash === undefined || (typeof v.fence_hash === "string" && /^[a-f0-9]{64}$/.test(v.fence_hash))) &&
    (v.content_hash === undefined || (typeof v.content_hash === "string" && /^[a-f0-9]{64}$/.test(v.content_hash))) &&
    (v.no_op === undefined || typeof v.no_op === "boolean") &&
    (v.operation_id === undefined || (typeof v.operation_id === "string" && /^rop-[a-f0-9]{64}$/.test(v.operation_id))) &&
    (v.request_hash === undefined || (typeof v.request_hash === "string" && /^[a-f0-9]{64}$/.test(v.request_hash))) &&
    [v.observed, v.sources, v.missing].every((a) => a === undefined || (Array.isArray(a) && a.length <= MAX_NODES && a.every((s) => typeof s === "string" && s.length > 0 && s.length <= 1024)));
}

export function decodeReview(json: unknown): MemoryEvent["review"] {
  if (json === undefined || json === null || json === "") return undefined;
  let value: unknown;
  try { value = typeof json === "string" ? JSON.parse(json) as unknown : json; }
  catch { throw new Error("Invalid review protocol payload"); }
  if (!validReview(value)) throw new Error("Invalid review protocol payload");
  return value;
}

const scopeOf = (r: { team_id?: string; user_id?: string; agent_id?: string }) => ({
  team_id: healIsoId(r.team_id ?? "")!, user_id: healIsoId(r.user_id ?? "")!, agent_id: healIsoId(r.agent_id ?? "")!,
});
const key = (scope: Node["scope"], id: string) => JSON.stringify([scope.team_id, scope.user_id, scope.agent_id, id]);
export function tokenOf(e: MemoryEvent): string {
  const token = e.review?.operation_id ?? e.event_id;
  if (!token) throw new Error("Control event identity required");
  return token;
}

class ReviewGraph {
  readonly nodes = new Map<string, Node>();
  private eventCount = 0;
  private eventBytes = 0;
  readonly clears = new Map<string, MemoryEvent | undefined>();

  constructor(private readonly roots: L1RecordRow[]) {
    for (const row of roots) this.add(scopeOf(row), row.record_id).row = row;
  }

  private add(scope: Node["scope"], id: string): Node {
    const k = key(scope, id);
    let n = this.nodes.get(k);
    if (!n) {
      if (this.nodes.size >= MAX_NODES) throw new Error("Review lineage node budget exceeded");
      n = { id, scope, events: [], loaded: false };
      this.nodes.set(k, n);
    }
    return n;
  }

  next(): Node[] {
    const first = [...this.nodes.values()].find((n) => !n.loaded);
    if (!first) return [];
    return [...this.nodes.values()].filter((n) => !n.loaded && key(n.scope, "") === key(first.scope, "")).slice(0, BATCH);
  }

  accept(nodes: Node[], rows: L1RecordRow[], events: MemoryEvent[]): void {
    this.eventCount += events.length;
    this.eventBytes += bytes.get(events) ?? events.reduce((n, e) => n + JSON.stringify(e).length * 2, 0);
    if (this.eventBytes > 64 * 1024 * 1024) throw new Error("Review graph memory budget exceeded");
    if (this.eventCount > MAX_EVENTS) throw new Error("Review history event budget exceeded");
    for (const n of nodes) {
      n.loaded = true;
      n.row = rows.find((r) => r.record_id === n.id && key(scopeOf(r), "") === key(n.scope, "")) ?? n.row;
      n.events = events.filter((e) => e.record_id === n.id && key(scopeOf(e), "") === key(n.scope, ""));
      for (const source of this.sources(n)) if (source !== n.id) this.add(n.scope, source);
    }
  }

  private sources(n: Node): string[] {
    const result = new Set<string>();
    if (n.row?.review_sources_json) {
      let parsed: unknown;
      try { parsed = JSON.parse(n.row.review_sources_json) as unknown; }
      catch { throw new Error("Invalid review lineage"); }
      if (!Array.isArray(parsed) || parsed.length > MAX_NODES || !parsed.every((s) => typeof s === "string" && s.length > 0 && s.length <= 1024)) throw new Error("Invalid review lineage");
      for (const s of parsed) if (s && s !== n.id) result.add(s);
    }
    for (const e of n.events) {
      if ((e.layer ?? "l1") === "l1" && ["created", "updated", "merged"].includes(e.op) && (e.source === undefined || e.source === "extraction")) {
        for (const s of e.review?.sources ?? e.supersedes ?? []) if (s !== n.id) result.add(s);
      }
    }
    return [...result];
  }

  result(): L1RecordRow[] {
    const own = new Map<string, Set<string>>();
    const removed = new Map<string, Set<string>>();
    const parents = new Map<string, string[]>();
    const values = new Map<string, Set<string>>();
    const incomplete = new Map<string, boolean>();
    for (const [k, n] of this.nodes) {
      const tokens = new Set<string>();
      const cancelled = new Set<string>();
      const clear = this.clears.get(JSON.stringify([n.scope.team_id, n.scope.agent_id]));
      const guard = n.row?.review_guard_at || n.row?.created_time || n.events.filter((e) => ["created", "updated", "merged"].includes(e.op)).map((e) => e.review?.guard_at ?? e.event_ts).sort()[0];
      if (guard && canonIsoTs(guard) !== guard) throw new Error("Invalid generation guard");
      const epoch = n.row?.review_epoch ?? n.events.find((event) => event.review?.guard_epoch !== undefined)?.review?.guard_epoch;
      if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) throw new Error("Invalid generation epoch");
      if (clear && (clear.review?.guard_epoch !== undefined ? epoch !== clear.review.guard_epoch : (!guard || guard <= clear.event_ts))) tokens.add(`clear:${tokenOf(clear)}`);
      const baseline = `baseline:${createHash("sha256").update(k).digest("hex")}`;
      if ((n.row?.review_tokens === undefined && normalizeReviewStatus(n.row?.review_status) === "quarantined") || (!n.row && !n.events.length)) tokens.add(baseline);
      for (const e of n.events) {
        if ((e.layer ?? "l1") !== "l1") continue;
        assertReviewEvent(e);
        if (e.review?.no_op) continue;
        if (e.op === "retracted") tokens.add(tokenOf(e));
        if (e.op === "reverted" && !e.supersedes?.includes(e.record_id) && !(e.target_event_id && n.events.some((write) => write.event_id === e.target_event_id && write.source === "api_mutation"))) tokens.add(`revert:${tokenOf(e)}`);
        if (e.op === "restored") {
          if (!e.review?.observed) throw new Error("Restore missing observed retractions");
          for (const t of e.review.observed) cancelled.add(t);
        }
      }
      own.set(k, tokens);
      removed.set(k, cancelled);
      parents.set(k, this.sources(n).map((s) => key(n.scope, s)));
      values.set(k, new Set());
      incomplete.set(k, !n.row && !n.events.length);
    }
    const children = new Map<string, Set<string>>();
    for (const [child, sources] of parents) for (const source of sources) {
      if (!children.has(source)) children.set(source, new Set());
      children.get(source)!.add(child);
    }
    const queue = [...this.nodes.keys()];
    const queued = new Set(queue);
    let propagated = 0;
    for (let index = 0; index < queue.length; index++) {
      if (index > 2_000_000) throw new Error("Review lineage propagation budget exceeded");
      const k = queue[index]!;
      queued.delete(k);
      const tokens = new Set(own.get(k));
      for (const p of parents.get(k)!) for (const t of values.get(p) ?? []) tokens.add(t);
      for (const t of removed.get(k)!) if (!t.startsWith("clear:") && !t.startsWith("revert:")) tokens.delete(t);
      const before = values.get(k)!;
      const missing = incomplete.get(k)! || parents.get(k)!.some((p) => incomplete.get(p));
      const missingChanged = missing !== incomplete.get(k);
      incomplete.set(k, missing);
      if (!missingChanged && tokens.size === before.size && [...tokens].every((t) => before.has(t))) continue;
      propagated += tokens.size - before.size;
      if (propagated > 1_000_000) throw new Error("Review lineage token budget exceeded");
      values.set(k, tokens);
      for (const child of children.get(k) ?? []) if (!queued.has(child)) { queue.push(child); queued.add(child); }
    }
    return this.roots.map((row) => {
      const tokens = [...values.get(key(scopeOf(row), row.record_id))!].sort();
      const invalid = row.review_status !== undefined && !["", "active", "quarantined"].includes(row.review_status);
      return { ...row, review_baseline: normalizeReviewStatus(this.nodes.get(key(scopeOf(row), row.record_id))?.row?.review_status), review_status: tokens.length ? "quarantined" : "active", review_tokens: tokens, ...(incomplete.get(key(scopeOf(row), row.record_id)) ? { review_incomplete: true } : {}), ...(invalid ? { review_invalid: true } : {}) };
    });
  }
}

const clearKey = (scope: { team_id?: string; agent_id?: string }) => JSON.stringify([healIsoId(scope.team_id ?? ""), healIsoId(scope.agent_id ?? "")]);
export const clearFilter = (scope: { team_id?: string; agent_id?: string }): MemoryEventFilter => ({ ...scope, op: "deleted", source: "api_mutation", scope: "agent", layer: "l1", order: "desc", order_by: "clear_epoch", limit: 1, metadata_only: true });

type GenerationGuard = { teamId?: string; agentId?: string; review_guard_at?: string; review_epoch?: number };

function validateGeneration(record: GenerationGuard, marker: MemoryEvent | undefined): void {
  const epoch = record.review_epoch;
  if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) throw new Error("Unverifiable generation epoch");
  if (marker?.review?.guard_epoch !== undefined) {
    if (epoch !== marker.review.guard_epoch) throw new ReviewConflictError("Generation invalidated by agent clear");
    return;
  }
  if (epoch !== undefined && epoch !== 0) throw new Error("Generation epoch has no committed clear fence");
  if (record.review_guard_at && canonIsoTs(record.review_guard_at) !== record.review_guard_at) throw new Error("Unverifiable generation guard");
  if (marker && record.review_guard_at && marker.event_ts >= record.review_guard_at) throw new ReviewConflictError("Generation invalidated by agent clear");
}

export function assertClearGuardSync(store: IMemoryStore, record: GenerationGuard): void {
  if (!store.queryMemoryEvents) throw new Error("Unverifiable generation guard");
  validateGeneration(record, sync(store.queryMemoryEvents(clearFilter({ team_id: record.teamId || "default", agent_id: record.agentId || "default" })))[0]);
}

export async function assertClearGuard(store: IMemoryStore, record: GenerationGuard): Promise<void> {
  if (!store.queryMemoryEvents) throw new Error("Unverifiable generation guard");
  validateGeneration(record, (await store.queryMemoryEvents(clearFilter({ team_id: record.teamId || "default", agent_id: record.agentId || "default" })))[0]);
}

function filters(nodes: Node[]): { rows: Parameters<IMemoryStore["queryL1Records"]>[0]; events: MemoryEventFilter } {
  const scope = nodes[0]!.scope;
  const ids = nodes.map((n) => n.id);
  return {
    rows: { recordIds: ids, teamId: scope.team_id, userId: scope.user_id, agentId: scope.agent_id, visibility: "all" },
    events: { ...scope, record_ids: ids, limit: PAGE, metadata_only: true },
  };
}

const sync = <T>(value: MaybePromise<T>): T => {
  if (value instanceof Promise) {
    void value.catch(() => undefined);
    throw new Error("Async store used in synchronous review resolver");
  }
  return value;
};

type ReviewProgram<T> = Generator<MaybePromise<unknown>, T, unknown>;

export function runSync<T>(program: ReviewProgram<T>): T {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try { value = sync(step.value); }
    catch (err) { step = program.throw(err); continue; }
    step = program.next(value);
  }
  return step.value;
}

export async function runAsync<T>(program: ReviewProgram<T>): Promise<T> {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try { value = await step.value; }
    catch (err) { step = program.throw(err); continue; }
    step = program.next(value);
  }
  return step.value;
}

export function queryReviewHistory(store: Pick<IMemoryStore, "queryMemoryEvents">, filter: MemoryEventFilter): MaybePromise<MemoryEvent[]> {
  if (!store.queryMemoryEvents) throw new Error("Review ledger unavailable");
  const checked = (events: MemoryEvent[]): MemoryEvent[] => {
    if (events.length > MEMORY_EVENT_HISTORY_LIMIT) throw new Error("Complete review history budget exceeded; narrow scope");
    const result: MemoryEvent[] = [];
    appendPage(result, events);
    return result;
  };
  const result = store.queryMemoryEvents({ ...filter, limit: MEMORY_EVENT_HISTORY_LIMIT + 1, offset: 0 }, { complete: true });
  return result instanceof Promise ? result.then(checked) : checked(result);
}

function* reviewResolution(store: IMemoryStore, rows: L1RecordRow[]): ReviewProgram<L1RecordRow[]> {
  if (!rows.length) return rows;
  if (!store.queryMemoryEvents) throw new Error("Review ledger unavailable");
  const graph = new ReviewGraph(rows);
  for (let nodes = graph.next(); nodes.length; nodes = graph.next()) {
    const f = filters(nodes);
    const raw = (yield store.queryL1Records(f.rows, { review: false, metadataOnly: true })) as L1RecordRow[];
    const events = (yield queryReviewHistory(store, f.events)) as MemoryEvent[];
    const ck = clearKey(nodes[0]!.scope);
    if (!graph.clears.has(ck)) graph.clears.set(ck, ((yield store.queryMemoryEvents(clearFilter({ team_id: nodes[0]!.scope.team_id, agent_id: nodes[0]!.scope.agent_id }))) as MemoryEvent[])[0]);
    graph.accept(nodes, raw, events);
  }
  return graph.result();
}

export function resolveReviewRowsSync(store: IMemoryStore, rows: L1RecordRow[]): L1RecordRow[] {
  return runSync(reviewResolution(store, rows));
}

export function resolveReviewRows(store: IMemoryStore, rows: L1RecordRow[]): Promise<L1RecordRow[]> {
  return runAsync(reviewResolution(store, rows));
}

function change(row: L1RecordRow, status: ReviewStatus, operation: Operation): MemoryEvent {
  const previous = normalizeReviewStatus(row.review_status);
  if (status === "active" && row.review_tokens?.some((t) => t.startsWith("clear:") || t.startsWith("revert:"))) throw new ReviewConflictError("Generation invalidated by clear or revert cannot be restored through visibility");
  const identity = operation.operation_id ?? `rop-${createHash("sha256").update(newMemoryEventId()).digest("hex")}`;
  const event: MemoryEvent = {
    event_ts: new Date().toISOString(),
    ...scopeOf(row), task_id: row.task_id || undefined, session_id: row.session_id, session_key: row.session_key,
    record_id: row.record_id, content: "", memory_type: row.type, version: row.version, source: "review", layer: "l1",
    op: status === "active" ? "restored" : "retracted", reason: operation.reason,
    reviewer_id: operation.reviewer_id, request_id: operation.request_id,
    review: { protocol: 2, operation_id: identity, request_hash: requestHash(row.record_id, status, operation), previous_status: previous, guard_epoch: row.review_epoch ?? undefined,
      ...(status === "active" && previous === "active" ? { no_op: true } : {}),
      ...(status === "active" ? { observed: row.review_tokens ?? [] } : {}) },
  };
  event.event_id = reviewEventId(event);
  if (!validReview(event.review)) throw new Error("Review operation exceeds protocol payload budget");
  return event;
}

export class ReviewConflictError extends Error {}
export class ReviewCapabilityError extends Error {}

export function reviewEventId(event: MemoryEvent): string {
  if (!event.review?.operation_id) throw new Error("Review operation identity required");
  return `evt-${createHash("sha256").update(JSON.stringify([scopeOf(event), event.layer ?? "l1", event.record_id, event.review.operation_id])).digest("hex").slice(0, 32)}`;
}

export function assertReviewEvent(event: MemoryEvent): void {
  if (event.review !== undefined && !validReview(event.review)) throw new Error("Invalid review protocol payload");
  if (event.source !== "review") {
    if (event.review?.operation_id) throw new Error("Review operation identity belongs to review commands");
    return;
  }
  if (!event.review?.operation_id || !event.review.request_hash || event.event_id !== reviewEventId(event)) throw new Error("Invalid committed review identity");
  if (event.op === "retracted" || event.op === "restored") {
    if (event.layer !== "l1" || event.review.previous_status === undefined) throw new Error("Review outcome required");
    if (event.op === "restored" && !event.review.observed) throw new Error("Restore observations required");
    if (event.op === "retracted" && event.review.no_op) throw new Error("A new retract operation cannot be a no-op");
  } else if (event.op === "reverted") {
    if (event.layer !== "l1" || !event.target_event_id || !Array.isArray(event.review.missing)) throw new Error("Revert receipt outcome required");
  } else if (event.op !== "updated" || !event.review.content_hash || !event.review.fence_hash) throw new Error("Invalid review command");
}

export function confirmReviewCommit(candidate: MemoryEvent, stored: MemoryEvent | undefined): MemoryEvent {
  assertReviewEvent(candidate);
  if (!stored) throw new Error("Committed review receipt unavailable");
  assertReviewEvent(stored);
  if (stored.review?.protocol !== 2 || stored.review.request_hash !== candidate.review?.request_hash ||
      stored.op !== candidate.op || stored.record_id !== candidate.record_id || stored.event_id !== candidate.event_id ||
      key(scopeOf(stored), "") !== key(scopeOf(candidate), "")) throw new ReviewConflictError("Review operation identity reused with different input");
  return stored;
}

const requestHash = (id: string, status: ReviewStatus, op: Operation) => createHash("sha256")
  .update(JSON.stringify([id, status, op.reason ?? "", op.reviewer_id ?? ""])).digest("hex");

function previousResult(e: MemoryEvent, id: string, status: ReviewStatus, op: Operation) {
  if (!e.review?.operation_id) throw new Error("Review receipt identity required");
  assertReviewEvent(e);
  if (e.review.request_hash !== requestHash(id, status, op)) throw new ReviewConflictError("Review operation identity reused with different input");
  return { changed: !e.review.no_op, previous: e.review.previous_status!, event: e };
}

export function resolveReviewFacts(rows: L1RecordRow[], events: MemoryEvent[]): L1RecordRow[] {
  const graph = new ReviewGraph(rows);
  graph.accept([...graph.nodes.values()], rows, events);
  return graph.result();
}

function historyFilter(id: string, filter?: IsolationFilter): MemoryEventFilter {
  return { record_id: id, layer: "l1", team_id: filter?.teamId, user_id: filter?.userId, agent_id: filter?.agentId, limit: PAGE };
}

export function historicalReviewRows(events: MemoryEvent[]): L1RecordRow[] {
  const records = new Map<string, L1RecordRow>();
  for (const e of events) {
    if ((e.layer ?? "l1") !== "l1" || !["created", "updated", "merged", "superseded", "retracted", "restored", "reverted"].includes(e.op)) continue;
    const scope = scopeOf(e);
    records.set(key(scope, e.record_id), {
      record_id: e.record_id, content: "", type: e.memory_type ?? "work_fact", priority: 0, scene_name: "",
      ...scope, task_id: e.task_id ?? "", session_key: e.origin_session_key ?? e.session_key,
      session_id: e.origin_session_id ?? e.session_id, version: e.version ?? 0, timestamp_str: "", timestamp_start: "", timestamp_end: "",
      created_time: "", updated_time: e.event_ts, metadata_json: "{}", review_status: "active", review_epoch: e.review?.guard_epoch,
    });
  }
  return [...records.values()];
}

function* historicalReviewRow(store: IMemoryStore, id: string, filter?: IsolationFilter): ReviewProgram<L1RecordRow | undefined> {
  const events = (yield queryReviewHistory(store, historyFilter(id, filter))) as MemoryEvent[];
  const row = historicalReviewRows(events)[0];
  if (!row || (filter?.taskId !== undefined && row.task_id !== filter.taskId)) return undefined;
  return (yield* reviewResolution(store, [row]))[0];
}

function* reviewCommand(store: IMemoryStore, id: string, status: ReviewStatus, filter: IsolationFilter | undefined, operation: Operation): ReviewProgram<ReturnType<typeof previousResult> | undefined> {
  if (!store.queryMemoryEvents || !store.commitMemoryEvent) throw new ReviewCapabilityError("Review requires an atomic immutable event ledger");
  if (operation.operation_id) {
    const prior = (yield store.queryMemoryEvents({ ...historyFilter(id, filter), operation_id: operation.operation_id, limit: 2 })) as MemoryEvent[];
    if (prior.length > 1) throw new ReviewConflictError("Duplicate review receipts violate immutable identity");
    if (prior[0]) return filter?.taskId !== undefined && (prior[0].task_id ?? "") !== filter.taskId ? undefined : previousResult(prior[0], id, status, operation);
  }
  const rows = (yield store.queryL1Records({ ...filter, recordIds: [id], visibility: "all" })) as L1RecordRow[];
  const row = rows[0] ?? (yield* historicalReviewRow(store, id, filter));
  if (!row) return undefined;
  const candidate = change(row, status, operation);
  const committed = (yield store.commitMemoryEvent(candidate)) as MemoryEvent;
  return previousResult(confirmReviewCommit(candidate, committed), id, status, operation);
}

export function setReviewStatusSync(store: IMemoryStore, id: string, status: ReviewStatus, filter?: IsolationFilter, operation: Operation = {}) {
  return runSync(reviewCommand(store, id, status, filter, operation));
}

export async function setReviewStatus(store: IMemoryStore, id: string, status: ReviewStatus, filter?: IsolationFilter, operation: Operation = {}) {
  return runAsync(reviewCommand(store, id, status, filter, operation));
}
