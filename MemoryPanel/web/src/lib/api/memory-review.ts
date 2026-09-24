/**
 * api/memory-review.ts — 记忆变更集（session diff）与撤销。
 *
 * 对应 Panel 后端 /api/v1/memory/*，透明代理到内核 /v3/memory/*。
 * v3 严格隔离：body 必须带 team_id / agent_id / user_id 三元组。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** diff 里单条变更。replaced 是被 superseded 的旧记录快照。 */
export interface MemoryDiffChange {
  op: 'created' | 'updated' | 'merged' | 'superseded' | 'reverted';
  record_id: string;
  content: string;
  memory_type?: string;
  version: number;
  event_ts: string;
  origin_session_id?: string;
  origin_session_key?: string;
  /** 该变更已被 revert 撤销。 */
  reverted?: boolean;
  /** 驳回者身份（reverted 事件的 reviewer_id，审核时的 isolation user）。 */
  reverted_by?: string;
  replaced: Array<{
    record_id: string;
    content: string;
    memory_type?: string;
    version: number;
    event_ts: string;
    origin_session_id?: string;
    origin_session_key?: string;
  }>;
}

export interface MemoryDiffData {
  changes: MemoryDiffChange[];
  /** 本页变更组数（分页在原始事件层，聚合在变更层，非全 session 总数）。 */
  count: number;
  /** 是否还有下一页事件。 */
  has_more: boolean;
  /** 下一页应传的 offset（事件偏移）。 */
  next_offset: number;
}

export interface MemoryRevertData {
  record_id: string;
  reverted: boolean;
  /** updated/merged 撤销时恢复的旧 record_id 列表。 */
  restored: string[];
  /** 快照缺失、无法恢复的旧 record_id（superseded 事件为 best-effort 写入）。 */
  missing?: string[];
}

/** 批量撤销的单项结果。 */
export interface MemoryRevertResultItem {
  record_id: string;
  reverted: boolean;
  restored?: string[];
  missing?: string[];
  /** reverted=false 时的 HTTP 语义状态码（404/409/500）。 */
  status?: number;
  error?: string;
}

export interface MemoryRevertBatchData {
  results: MemoryRevertResultItem[];
  succeeded: number;
  failed: number;
}

/** memory/history 返回的单条事件（record 血统）。 */
export interface MemoryHistoryEvent {
  event_ts: string;
  session_key: string;
  session_id: string;
  origin_session_id?: string;
  op: 'created' | 'updated' | 'merged' | 'superseded' | 'reverted';
  record_id: string;
  content: string;
  memory_type?: string;
  version: number;
  supersedes?: string[];
  superseded_by?: string;
  reviewer_id?: string;
}

export interface MemoryHistoryData {
  record_id: string;
  events: MemoryHistoryEvent[];
  count: number;
  has_more: boolean;
  next_offset: number;
}

/** 收件箱里一个 session 的变更摘要。 */
export interface MemoryReviewInboxSession {
  session_id: string;
  session_key: string;
  /** 本窗内 created/updated/merged 变更数（superseded/reverted 不计）。 */
  changes: number;
  by_op: Record<string, number>;
  last_event_ts: string;
  /** 该 session 含 reverted 事件（有被驳回的变更）。 */
  has_reverted: boolean;
}

export interface MemoryReviewInboxData {
  sessions: MemoryReviewInboxSession[];
  /** 扫描到事件上限——还有更早的变更未聚合，收窄时间窗再查。 */
  truncated: boolean;
  scanned: number;
}

const PREFIX = '/api/v1/memory';

async function call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `${PREFIX}/${endpoint}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const memoryReviewApi = {
  /** 查询某 session 的 L1 变更集（聚合视图）。 */
  diff: (params: { session_id: string; team_id: string; agent_id: string; user_id: string; limit?: number; offset?: number; op?: string; since?: string; until?: string }) =>
    call<MemoryDiffData>('diff', { ...params }),

  /** 撤销一条变更：created→删记录；updated/merged→删新+恢复 superseded 快照。 */
  revert: (params: { record_id: string; team_id: string; agent_id: string; user_id: string; reason?: string }) =>
    call<MemoryRevertData>('diff/revert', { ...params }),

  /** 批量撤销（≤50 条/次）：返回逐项结果，单条失败不阻塞其他。 */
  revertBatch: (params: { record_ids: string[]; team_id: string; agent_id: string; user_id: string; reason?: string }) =>
    call<MemoryRevertBatchData>('diff/revert', { ...params }),

  /** 单条记录的完整事件血统（created→…→reverted）。 */
  history: (params: { record_id: string; team_id: string; agent_id: string; user_id: string; limit?: number; offset?: number }) =>
    call<MemoryHistoryData>('history', { ...params }),

  /** 收件箱：tenant 维度最近有变更的 session 列表（不需要先知道 session_id）。 */
  inbox: (params: { team_id: string; agent_id: string; user_id: string; since?: string; until?: string; limit?: number }) =>
    call<MemoryReviewInboxData>('review/inbox', { ...params }),
};
