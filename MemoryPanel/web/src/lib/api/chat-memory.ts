/**
 * api/chat-memory.ts — Chat Memory 面板专用业务路由（/api/v1/chat-memory/*）。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** 记忆块列表项（team-assets / agent-fixed / my-agents 共用） */
export interface ChatMemoryBlock {
  id: string;
  title: string;
  summary?: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  /** 仅 team-assets */
  bound_agent_count?: number;
  /** 仅 agent-fixed */
  agent_id?: string;
  /** 资产可见范围：agent-fixed / my-agents 由 visibility 映射返回；team-assets 不返回（恒为 team） */
  scope?: 'team' | 'private';
}

/** 分层懒加载条目 */
export interface ChatMemoryLayerItem {
  id: string;
  role?: string;
  title: string;
  body: string;
  tags?: string[];
  refs?: string[];
  /** 条目创建/记录时间（ISO8601），backend 从 recorded_at_ms / created_time_ms / updated_at 转换 */
  created_at?: string;
}

/** L1 语义搜索命中项：在分层条目基础上附带相关度 score（越大越相关） */
export interface ChatMemorySearchHit extends ChatMemoryLayerItem {
  score?: number;
}

const CHAT_MEMORY_PREFIX = '/api/v1/chat-memory';

async function chatMemoryCall<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `${CHAT_MEMORY_PREFIX}/${endpoint}`,
    body,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const chatMemoryApi = {
  /** 团队 Memory 池：当前团队所有已共享的 chat_memory */
  teamAssets: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('team-assets', { team_id: teamId }),

  /** Agent 固定资产 */
  agentFixed: (agentId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('agent-fixed', {
      agent_id: agentId,
    }),

  /** 我的资产分配（owner=me 的 agent 列表） */
  myAgents: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[] }>('my-agents', { team_id: teamId }),

  /** L0/L1/L2/L3 分层懒加载；L2 可传 path 懒读单个 Markdown 原文。
   *  L0 游标分页：第一页传 offset=0；后续页传 beforeTs（最后一条消息的 created_at），
   *  后端用 time_end 过滤，offset 归零，避免 VDB 大 offset 扫描。 */
  layer: (
    blockId: string,
    l: 'L0' | 'L1' | 'L2' | 'L3',
    limit = 50,
    offset = 0,
    path?: string,
    beforeTs?: string,
    timeStart?: string,
    timeEnd?: string,
  ) =>
    chatMemoryCall<{
      layer: string;
      items: ChatMemoryLayerItem[];
      total: number;
      limit: number;
      offset: number;
    }>('layer', {
      block_id: blockId,
      layer: l,
      limit,
      offset,
      ...(path ? { path } : {}),
      ...(beforeTs ? { before_ts: beforeTs } : {}),
      // 详情页时间筛选器（ISO8601），仅 L0 / L1 生效，后端对 L2 / L3 忽略
      ...(timeStart ? { time_start: timeStart } : {}),
      ...(timeEnd ? { time_end: timeEnd } : {}),
    }),

  /** 批量设置某个 agent 的固定 memory，后端会原子校验借入上限。 */
  setAgentFixed: (teamId: string, agentId: string, blockIds: string[]) =>
    chatMemoryCall<{ updated: boolean; agent_id: string; block_ids: string[] }>('set-agent-fixed', {
      team_id: teamId,
      agent_id: agentId,
      block_ids: blockIds,
    }),

  /** 借入资产到我的 agent */
  allocate: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ allocated: boolean; agent_id: string; block_id: string }>('allocate', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** 从 agent 解绑 */
  unbind: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ unbound: boolean; agent_id: string; block_id: string }>('unbind', {
      team_id: teamId,
      block_id: blockId,
      agent_id: agentId,
    }),

  /** 手工建独立 UserAsset */
  create: (teamId: string, title: string, scope: 'team' | 'private', description?: string) =>
    chatMemoryCall<ChatMemoryBlock>('create', { team_id: teamId, title, scope, description }),

  /** 切换资产可见范围 */
  patchScope: (blockId: string, scope: 'team' | 'private') =>
    chatMemoryCall<{ updated: boolean; id: string; scope: string }>('patch-scope', {
      block_id: blockId,
      scope,
    }),

  /** 导入历史对话到 agent 的 L0（走 /v3/conversation/add） */
  import: (params: {
    teamId: string;
    agentId: string;
    messages: Array<{ role: string; content: string }>;
    sessionId?: string;
  }) =>
    chatMemoryCall<{
      imported: boolean;
      block_id: string;
      session_id: string;
      accepted_count: number;
    }>('import', {
      team_id: params.teamId,
      agent_id: params.agentId,
      messages: params.messages,
      session_id: params.sessionId,
    }),

  /** 编辑单层记忆内容（Owner-only）：
   *  L1 传 id=记录主键 + content；L2 传 id=文件路径 + content（可选 summary）；
   *  L3 只传 content（整份 core persona 覆盖写）。 */
  updateLayer: (
    blockId: string,
    layer: 'L1' | 'L2' | 'L3',
    params: { id?: string; content: string; summary?: string },
  ) =>
    chatMemoryCall<{
      id?: string;
      path?: string;
      version?: string;
      updated_at?: string;
    }>('layer-update', {
      block_id: blockId,
      layer,
      ...(params.id ? { id: params.id } : {}),
      content: params.content,
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
    }),

  /** 分层语义 / 关键字搜索（agent 维度跨 session 召回，命中项带 score）：
   *  L0 = 对话消息检索；L1 = 原子记忆检索。 */
  searchLayer: (
    blockId: string,
    layer: 'L0' | 'L1',
    query: string,
    limit = 30,
    type?: string,
  ) =>
    chatMemoryCall<{ items: ChatMemorySearchHit[]; total: number }>('search', {
      block_id: blockId,
      layer,
      query,
      limit,
      ...(type ? { type } : {}),
    }),
};
