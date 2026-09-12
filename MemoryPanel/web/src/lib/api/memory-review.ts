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
  total: number;
}

export interface MemoryRevertData {
  record_id: string;
  reverted: boolean;
  /** updated/merged 撤销时恢复的旧 record_id 列表。 */
  restored: string[];
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
  diff: (params: { session_id: string; team_id: string; agent_id: string; user_id: string; limit?: number; offset?: number }) =>
    call<MemoryDiffData>('diff', { ...params }),

  /** 撤销一条变更：created→删记录；updated/merged→删新+恢复 superseded 快照。 */
  revert: (params: { record_id: string; team_id: string; agent_id: string; user_id: string; reason?: string }) =>
    call<MemoryRevertData>('diff/revert', { ...params }),
};
