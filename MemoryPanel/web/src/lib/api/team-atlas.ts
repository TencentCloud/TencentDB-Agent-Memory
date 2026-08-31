import { getPanelSession } from '../panelSession';
import { ApiError, request } from './base';
import type { MetaEnvelope } from './types';

export type TeamAtlasNodeType =
  'identity' | 'team' | 'task' | 'agent' | 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

export type TeamAtlasRelation =
  | 'member_of'
  | 'belongs_to'
  | 'created_by'
  | 'owns'
  | 'planned_for'
  | 'used_in_session'
  | 'records_to'
  | 'contains_task_l0'
  | 'initialized_by'
  | 'initialized_on'
  | 'fixed_binding'
  | 'recalled_from';

export type TeamAtlasMode = 'actual' | 'planned' | 'all';

export interface TeamAtlasNode {
  id: string;
  entity_id: string;
  type: TeamAtlasNodeType;
  label: string;
  team_id?: string;
  status?: string;
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

export interface TeamAtlasEdge {
  id: string;
  type: TeamAtlasRelation;
  source: string;
  target: string;
  team_id?: string;
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

export interface TeamAtlasWarning {
  code: string;
  node_id?: string;
  source?: string;
  message: string;
}

export interface TaskPlanFact {
  id: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string;
}

export interface AssetBindingFact {
  id: string;
  team_id: string;
  agent_id: string;
  asset_id: string;
  asset_type: TeamAtlasNodeType;
}

export interface TeamAtlasIR {
  schema_version: 2;
  generated_at: string;
  mode: TeamAtlasMode;
  scope: { user_id: string; team_ids: string[] };
  completeness: 'complete' | 'partial';
  summary: {
    teams: number;
    tasks: number;
    agents: number;
    assets: number;
    edges: number;
    warnings: number;
  };
  nodes: TeamAtlasNode[];
  edges: TeamAtlasEdge[];
  activities: Array<{
    id: string;
    team_id: string;
    task_id: string;
    user_id: string;
    agent_id: string;
    l0_session_count: number;
    l0_message_count: number;
    participation_event_count: number;
    first_seen_at?: string;
    last_seen_at?: string;
    evidence: 'l0_and_participation' | 'l0_only' | 'participation_only';
    state: 'recorded_dialogue' | 'initialized_no_dialogue' | 'initialized_l0_unknown';
    own_chat_memory_id: string;
    /** null means Chat Memory registration could not be confirmed from a partial source. */
    chat_memory_registered: boolean | null;
    counts_exact: boolean;
  }>;
  plans: TaskPlanFact[];
  bindings: AssetBindingFact[];
  warnings: TeamAtlasWarning[];
}

export interface ChatMemoryStatus {
  block_id: string;
  checked_at: string;
  availability: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  layer_counts: {
    L0_messages: number | null;
    L1: number | null;
    L2: number | null;
    L3: number | null;
  };
  unavailable_layers: string[];
}

async function atlasCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `/api/v1/${path}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0 || envelope.data == null) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data;
}

export const teamAtlasApi = {
  bootstrap: (teamIds: string[], mode?: TeamAtlasMode) =>
    atlasCall<TeamAtlasIR>('topology/bootstrap', {
      team_ids: teamIds,
      ...(mode ? { mode } : {}),
    }),
  memoryStatus: (blockId: string) =>
    atlasCall<ChatMemoryStatus>('chat-memory/status', { block_id: blockId }),
};
