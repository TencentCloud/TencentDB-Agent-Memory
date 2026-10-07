import { createHash, randomUUID } from "node:crypto";
import type { IMemoryStore, IsolationFilter, L1RecordRow, MemoryEvent, MemoryEventFilter, MaybePromise } from "../store/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { confirmReviewCommit, queryReviewHistory, ReviewCapabilityError, ReviewConflictError, reviewEventId, runAsync } from "../store/review.js";
import { healIsoId } from "../store/memory-event-id.js";
import { appendLedgerEvent } from "./event-ledger.js";
import { rowToMemoryRecord } from "./l1-reader.js";

type RevertStore = IMemoryStore & Required<Pick<IMemoryStore, "queryMemoryEvents" | "commitMemoryEvent" | "executeMemoryTransaction">>;
type Program<T> = Generator<MaybePromise<unknown>, T, unknown>;
export interface RevertOptions {
  reason?: string;
  /** 放行"提取写入之后被人工编辑"的冲突，丢弃人工编辑。 */
  force?: boolean;
  /** 指定要撤销的那次写入事件（逐层回退人工编辑时使用）。缺省为最后一次提取写入。 */
  eventId?: string;
  reviewerId?: string;
  operationId?: string;
}

export type RevertOutcome =
  | { ok: true; record_id: string; restored: string[]; missing?: string[]; target_event_id?: string; operation_id: string; outbox_pending?: boolean }
  | { ok: false; record_id: string; status: number; error: string; operation_id?: string; commit_unknown?: boolean };
type RevertPlan =
  | { ok: false; status: number; error: string }
  | { ok: true; target: MemoryEvent; restores: Array<{ targetId: string; snap?: MemoryEvent }> };

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const WRITE_OPS: ReadonlySet<MemoryEvent["op"]> = new Set(["created", "updated", "merged"]);
const rowFilter = (iso?: IsolationFilter) => ({ teamId: iso?.teamId, userId: iso?.userId, agentId: iso?.agentId, taskId: iso?.taskId });
const eventScope = (iso?: IsolationFilter): MemoryEventFilter => ({ team_id: iso?.teamId, user_id: iso?.userId, agent_id: iso?.agentId });

/** 返回 ids 中当前仍有存活行的记录；查询失败传播，守卫必须 fail-closed。 */
function* liveRecordIds(store: RevertStore, ids: string[], filter: IsolationFilter): Program<string[]> {
  const result: string[] = [];
  for (let i = 0; i < ids.length; i += 400) { // 避开 SQLite 绑定参数上限
    const rows = (yield store.queryL1Records({ recordIds: ids.slice(i, i + 400), ...filter, visibility: "all" }, { review: false, metadataOnly: true })) as L1RecordRow[];
    result.push(...rows.map((r) => r.record_id));
  }
  return result;
}

export function isManagementScopeDelete(event: MemoryEvent): boolean {
  return event.source === "api_mutation" && event.op === "deleted" && event.scope === "agent";
}

/**
 * 定位写入并执行只读守卫。最终计划在数据库事务内重新构建，
 * 预计算 embedding 的外部读取不能作为提交依据。
 */
function* planRevert(store: RevertStore, recordId: string, opts: RevertOptions, iso?: IsolationFilter): Program<RevertPlan> {
  // 守卫读的是事件账：历史完整性优先于 task 维度的收敛——同一记录的
  // 写入/标记可能挂在不同 task_id 下（跨 task 的 dedup 合并、管理面编辑），
  // 按 task 过滤会让 deleted/reverted 标记对守卫隐身。行级读写仍带完整
  // 租户四元组（rowFilter/deleteFilter）：看不见的行本来就不可撤销。
  const scope = eventScope(iso);
  const filter = rowFilter(iso);
  const fail = (status: number, error: string): RevertPlan => ({ ok: false, status, error });
  const events = (yield queryReviewHistory(store, { ...scope, record_id: recordId })) as MemoryEvent[];
  const writes = events.filter((event) => WRITE_OPS.has(event.op));
  const reverts = events.filter((event) => event.op === "reverted");
  const revertedIds = new Set(reverts.map((event) => event.target_event_id).filter((id): id is string => !!id));
  const isExtraction = (event: MemoryEvent) => event.source !== "api_mutation";
  const isReverted = (event: MemoryEvent) => !!event.event_id && revertedIds.has(event.event_id);
  const target = opts.eventId ? writes.find((event) => event.event_id === opts.eventId) : writes.filter(isExtraction).pop();
  if (!target) return fail(404, `No memory write event found for record ${recordId}`);
  // L2/L3 事件只记录"发生了什么操作"，不带可恢复的前像——撤销只对 L1 定义。
  // 显式拒绝，而不是依赖后面"L1 行不存在"的守卫碰巧挡住。
  if ((target.layer ?? "l1") !== "l1") return fail(409, `Event belongs to ${target.layer}; only L1 changes can be reverted`);
  if (isReverted(target)) return fail(409, `Record ${recordId} has already been reverted`);
  if (events.some((event) => event.op === "deleted")) return fail(409, `Record ${recordId} was deleted; reverting would resurrect removed data`);
  // 范围删除守卫：clear/archive 按 team+agent 整体清空，事件挂在资产 id 上。
  const deletions = (yield queryReviewHistory(store, { op: "deleted", source: "api_mutation", team_id: iso?.teamId, agent_id: iso?.agentId, since: target.event_ts, metadata_only: true })) as MemoryEvent[];
  const cleared = deletions.find((event) => isManagementScopeDelete(event) && event.record_id !== recordId && (!event.user_id || event.user_id === "default" || event.user_id === iso?.userId));
  if (cleared) return fail(409, `Memory was cleared after this write; reverting would resurrect cleared data`);
  // 行存在性：记录已被删除 / 清空 / TTL 过期 → 不可撤销（恢复快照即复活）。
  if (!(yield* liveRecordIds(store, [recordId], filter)).length) return fail(409, `Record ${recordId} no longer exists (deleted, cleared or expired)`);
  const currentEpoch = store.getClearEpoch ? (yield store.getClearEpoch({ teamId: iso?.teamId, agentId: iso?.agentId })) as number : 0;
  const targetRows = (yield store.queryL1Records({ ...filter, recordIds: [recordId], visibility: "all" }, { review: false, metadataOnly: true })) as L1RecordRow[];
  if (currentEpoch > 0 && targetRows[0]?.review_epoch !== currentEpoch) return fail(409, "Record generation was invalidated by clear; refusing resurrection");
  const later = writes.slice(writes.indexOf(target) + 1).filter((event) => !isReverted(event));
  if (!isExtraction(target)) {
    // 撤销人工编辑：必须是该记录最新的一层，且带编辑前快照。
    if (later.length) return fail(409, `Record ${recordId} has newer changes; revert those first`);
    if (!target.snapshot_json) return fail(409, "Manual edit has no pre-edit snapshot and cannot be reverted");
    return { ok: true, target, restores: [] };
  }
  // 人工编辑守卫：提取写入之后被管理面编辑过 → 默认拒绝，force 显式丢弃人工编辑。
  if (later.length && !opts.force) return fail(409, `Record ${recordId} has newer writes; revert those first or pass force:true`);
  // 链守卫：沿 superseded_by 向下走，任一后代仍有存活行 → 驳回本记录会让
  // 祖先与存活者共存 → 409。上限 5 跳防环；到顶还没走完说明链比上限深，
  // 无法确认最深后代是否存活——与其它守卫一样 fail closed，不放行。
  const frontier = [...new Set(events.filter((event) => event.op === "superseded" && event.superseded_by).map((event) => event.superseded_by!))];
  const visited = new Set([recordId]);
  for (let hop = 0; hop < 5 && frontier.length; hop++) {
    const chunk = frontier.splice(0).filter((id) => !visited.has(id));
    const live = yield* liveRecordIds(store, chunk, filter);
    if (live.length) return fail(409, `Record ${recordId} is currently superseded by ${live.join(", ")}`);
    for (const id of chunk) {
      visited.add(id);
      const childEvents = (yield queryReviewHistory(store, { ...scope, record_id: id })) as MemoryEvent[];
      for (const event of childEvents) if (event.op === "superseded" && event.superseded_by && !visited.has(event.superseded_by)) frontier.push(event.superseded_by);
    }
  }
  if (frontier.length) return fail(503, "Supersession chain is deeper than 5 hops; cannot verify descendants");
  // 分叉守卫：待恢复的旧记录若还被其它存活记录替代（并发 session 各自
  // supersede 了同一条），恢复它会与那个后继共存 → 409。
  const restores: Array<{ targetId: string; snap?: MemoryEvent }> = [];
  if (target.op !== "created") for (const targetId of target.supersedes ?? []) {
    const history = (yield queryReviewHistory(store, { ...scope, record_id: targetId })) as MemoryEvent[];
    if (history.some((event) => event.op === "deleted")) return fail(409, `Restore target ${targetId} was deleted; refusing resurrection`);
    const superseded = history.filter((event) => event.op === "superseded");
    const siblings = [...new Set(superseded.map((event) => event.superseded_by).filter((id): id is string => !!id && id !== recordId))];
    const live = yield* liveRecordIds(store, siblings, filter);
    if (live.length) return fail(409, `Restore target ${targetId} has live successors ${live.join(", ")}`);
    restores.push({ targetId, snap: superseded.filter((event) => event.superseded_by === recordId).pop() });
  }
  // 快照守卫：旧记录没有可恢复的快照（写入缺口 / 已被 clear/TTL 擦除）时，
  // 撤销等于直接删掉新记录 → 默认拒绝，force 显式接受只删不恢复。
  if (!opts.force && restores.some((restore) => !restore.snap?.snapshot_json)) return fail(409, "No restorable snapshot; pass force:true to delete without restoring");
  return { ok: true, target, restores };
}

/**
 * 事务中的任何失败都中止整个撤销，不用逐行删回恢复数据。
 * 无法确认 COMMIT 结果时只查持久收据，不根据瞬时行状态猜测成功。
 */
class RevertAbort extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const requestHash = (recordId: string, opts: RevertOptions) => hashOf([recordId, opts.eventId ?? "", !!opts.force, opts.reason ?? "", opts.reviewerId ?? ""]);
const receiptOutcome = (event: MemoryEvent, operationId: string): Extract<RevertOutcome, { ok: true }> => ({
  ok: true, record_id: event.record_id, restored: event.supersedes ?? [], operation_id: operationId,
  ...(event.review?.missing?.length ? { missing: event.review.missing } : {}), ...(event.target_event_id ? { target_event_id: event.target_event_id } : {}),
});

function* commitRevert(store: RevertStore, recordId: string, opts: RevertOptions, identity: string, embeddings: Map<string, { content: string; vector?: Float32Array }>, iso?: IsolationFilter): Program<MemoryEvent> {
  const prior = (yield store.queryMemoryEvents({ ...eventScope(iso), record_id: recordId, source: "review", op: "reverted", operation_id: identity, limit: 2 })) as MemoryEvent[];
  if (prior.length > 1) throw new ReviewConflictError("Duplicate revert receipts violate immutable identity");
  if (prior[0]) {
    if (!prior[0].review?.operation_id) throw new Error("Revert receipt identity required");
    if (prior[0].review.request_hash !== requestHash(recordId, opts)) throw new ReviewConflictError("Revert operation identity reused with different input");
    return prior[0];
  }
  let plan: RevertPlan;
  try { plan = yield* planRevert(store, recordId, opts, iso); }
  catch { throw new RevertAbort(503, "Revert guard query failed; nothing was changed, retry later"); }
  if (!plan.ok) throw new RevertAbort(plan.status, plan.error);
  const { target, restores } = plan;
  const manual = target.source === "api_mutation" || target.supersedes?.includes(recordId) === true;
  const snapshots = target.source === "api_mutation" ? [{ targetId: recordId, snap: target }] : restores;
  const restored: string[] = [];
  const missing: string[] = [];
  // filter 只用 team/user/agent/task 做租户隔离——revert 按 record_id 定位，
  // 目标可能属于别的 session（跨 session supersede 是正常场景）。
  const filter = rowFilter(iso);
  for (const item of snapshots) {
    // superseded 快照缺失（best-effort 写入缺口 / 已被 clear/TTL 擦除），重试也无法恢复。
    if (!item.snap?.snapshot_json) { missing.push(item.targetId); continue; }
    const record = { ...rowToMemoryRecord(JSON.parse(item.snap.snapshot_json) as L1RecordRow), updatedAt: new Date().toISOString(), review_guard_at: target.event_ts };
    if (record.id !== item.targetId) throw new RevertAbort(409, "Snapshot identity does not match restore target");
    for (const [actual, expected] of [[record.teamId, target.team_id], [record.userId, target.user_id], [record.agentId, target.agent_id]]) {
      if (healIsoId(actual ?? "") !== healIsoId(expected ?? "")) throw new RevertAbort(409, "Snapshot belongs to another isolation scope");
    }
    if (iso?.taskId !== undefined && (record.taskId ?? "") !== iso.taskId) throw new RevertAbort(409, "Snapshot is outside the requested task scope");
    const existing = (yield store.queryL1Records({ ...filter, recordIds: [item.targetId], visibility: "all" }, { review: false })) as L1RecordRow[];
    if (!manual && existing[0]) {
      if (existing[0].content !== record.content || existing[0].version !== (record.version ?? 0)) throw new RevertAbort(409, "A restore target has independent live changes");
    } else {
      const cached = embeddings.get(record.id);
      const vector = cached?.content === record.content ? cached.vector : undefined;
      if (!(yield store.upsertL1({ ...record, ...(manual ? { expected_existing: true } : {}) }, vector))) throw new RevertAbort(500, "Snapshot restore failed; transaction rolled back");
    }
    restored.push(record.id);
  }
  // 删除报错也必须回滚整个事务；不在未提交的行状态上推断成功。
  if (!manual && !(yield store.deleteL1(recordId, filter))) throw new RevertAbort(500, "Target deletion failed; transaction rolled back");
  // reverted 事件：session 归属用被撤销写入的原 session（出现在被变更 session
  // 的 diff 里）；target_event_id 精确指向被撤销的那一层。租户归属与所有账本
  // 行一致取记录（target）自身的租户——请求方身份只进 reviewer_id。
  const event: MemoryEvent = {
    event_ts: new Date().toISOString(), session_key: target.session_key, session_id: target.session_id,
    team_id: target.team_id ?? iso?.teamId ?? "default", user_id: target.user_id ?? iso?.userId ?? "default", agent_id: target.agent_id ?? iso?.agentId ?? "default", task_id: target.task_id,
    op: "reverted", record_id: recordId, layer: "l1", source: "review", content: opts.reason ?? target.content, reason: opts.reason,
    target_event_id: target.event_id, memory_type: target.memory_type, version: target.version, supersedes: restored, reviewer_id: opts.reviewerId,
    review: { protocol: 2, operation_id: identity, request_hash: requestHash(recordId, opts), guard_epoch: target.review?.guard_epoch, missing },
  };
  event.event_id = reviewEventId(event);
  const committed = (yield store.commitMemoryEvent(event)) as MemoryEvent;
  return confirmReviewCommit(event, committed);
}

/**
 * 数据库事务拥有撤销串行化：各实例共享同一提交约束，不使用进程内 mutex。
 * embedding 预计算及 outbox 发布在事务外，故障不能把未提交动作写进恢复日志。
 */
export async function revertMemory(params: { store: IMemoryStore; recordId: string; options: RevertOptions; isolation?: IsolationFilter; storage?: StorageAdapter; embedding?: EmbeddingService; logger: Logger }): Promise<RevertOutcome> {
  const { store, recordId, options: opts, isolation: iso, storage, embedding, logger } = params;
  if (!store.queryMemoryEvents || !store.commitMemoryEvent || !store.executeMemoryTransaction) return { ok: false, record_id: recordId, status: 501, error: "Physical revert requires a transactional immutable ledger" };
  const supported = store as RevertStore;
  const operationId = opts.operationId ?? randomUUID();
  const identity = `rop-${hashOf(["revert", healIsoId(iso?.teamId ?? ""), healIsoId(iso?.userId ?? ""), healIsoId(iso?.agentId ?? ""), iso?.taskId ?? null, recordId, operationId])}`;
  const embeddings = new Map<string, { content: string; vector?: Float32Array }>();
  try {
    if (embedding) {
      const plan = await runAsync(planRevert(supported, recordId, opts, iso));
      if (plan.ok) for (const item of (plan.target.source === "api_mutation" ? [{ targetId: recordId, snap: plan.target }] : plan.restores)) {
        if (!item.snap?.snapshot_json) continue;
        const record = rowToMemoryRecord(JSON.parse(item.snap.snapshot_json) as L1RecordRow);
        let vector: Float32Array | undefined;
        try { vector = await embedding.embed(record.content); } catch { vector = undefined; } // metadata+FTS only
        embeddings.set(record.id, { content: record.content, vector });
      }
    }
  } catch {
    return { ok: false, record_id: recordId, status: 503, error: "Revert preparation failed; nothing was changed, retry later", operation_id: operationId };
  }
  let event: MemoryEvent;
  try {
    event = await supported.executeMemoryTransaction(() => commitRevert(supported, recordId, opts, identity, embeddings, iso));
  } catch (err) {
    // Raw backend errors carry DSN/topology — do not log or echo their text.
    logger.warn(`[memory-revert] transaction could not be confirmed record_id=${recordId}`);
    if (err instanceof RevertAbort || err instanceof ReviewConflictError || err instanceof ReviewCapabilityError) return { ok: false, record_id: recordId, status: err instanceof RevertAbort ? err.status : err instanceof ReviewCapabilityError ? 501 : 409, error: err.message, operation_id: operationId };
    try {
      const receipts = await supported.queryMemoryEvents({ ...eventScope(iso), record_id: recordId, operation_id: identity, limit: 2 });
      if (receipts.length !== 1 || receipts[0].review?.request_hash !== requestHash(recordId, opts)) throw new Error("Revert receipt unavailable");
      event = receipts[0];
    } catch {
      return { ok: false, record_id: recordId, status: 503, error: "Revert commit could not be confirmed; retry with the same operation_id", operation_id: operationId, commit_unknown: true };
    }
  }
  // 撤销事实已随事务提交；outbox 失败不能撤销权威收据或冒充账本未提交。
  const mirrored = await appendLedgerEvent({ store, storage, event, logger, storeAlreadyCommitted: true });
  return { ...receiptOutcome(event, operationId), ...(storage && !mirrored.jsonl ? { outbox_pending: true } : {}) };
}
