import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaCallContext } from '../../kernel/types.js';
import { toKernelCredentials } from '../../kernel/types.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import {
  buildCtx,
  extractListItems,
  fetchAllMetaListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  strArray,
} from './knowledge/common.js';

export type TeamAtlasNodeType =
  | 'identity'
  | 'team'
  | 'task'
  | 'agent'
  | 'skill'
  | 'llm_wiki'
  | 'code_graph'
  | 'chat_memory';

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
  metadata?: Record<string, unknown>;
}

export interface TeamAtlasEdge {
  id: string;
  type: TeamAtlasRelation;
  source: string;
  target: string;
  team_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamAtlasWarning {
  code:
    | 'SOURCE_PARTIAL'
    | 'TEAM_WITHOUT_TASKS'
    | 'TEAM_WITHOUT_AGENTS'
    | 'TASK_WITHOUT_AGENTS'
    | 'TASK_WITHOUT_PARTICIPATION'
    | 'TASK_PARTICIPATION_UNASSIGNED_AGENT'
    | 'AGENT_WITHOUT_REUSABLE_ASSETS'
    | 'ASSET_NOT_BOUND';
  node_id?: string;
  source?: string;
  message: string;
}

interface TeamRaw {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: string;
}

interface TeamMemberRaw {
  user_id: string;
  username?: string;
  role?: string;
  status?: string;
}

interface TaskRaw {
  task_id: string;
  team_id: string;
  title: string;
  status?: string;
  creator_user_id?: string;
  source_type?: string;
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  status?: string;
  created_at?: string;
}

interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: TeamAtlasNodeType;
  name: string;
  owner_user_id: string;
  status?: string;
  visibility?: string;
}

interface TaskAgentRaw {
  task_id: string;
  agent_id: string;
  role_in_task?: string | null;
  status?: string;
}

interface ParticipationLogRaw {
  task_id: string;
  agent_id: string;
  user_id: string;
  source?: string;
  created_at?: string;
}

export interface L0TaskActivityRow {
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  session_count: number;
  l0_message_count: number;
  first_seen_at?: string;
  last_seen_at?: string;
}

interface L0TaskActivityResponse {
  items: L0TaskActivityRow[];
  completeness: 'complete' | 'partial';
  truncated: boolean;
  scanned_records?: number;
}

export interface TaskActivityFact {
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
  chat_memory_registered: boolean | null;
  counts_exact: boolean;
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

interface FixedAssetRaw {
  asset_id: string;
  asset_type: string;
}

interface SkillRaw {
  skill_id: string;
  owner_agent_id?: string;
  status?: string;
}

export interface TeamAtlasSnapshot {
  team: TeamRaw;
  role?: string;
  members: TeamMemberRaw[];
  tasks: TaskRaw[];
  agents: AgentRaw[];
  assets: AssetRaw[];
  taskAgents: TaskAgentRaw[];
  participationLogs: ParticipationLogRaw[];
  fixedAssets: Array<FixedAssetRaw & { agent_id: string }>;
  skills: SkillRaw[];
  activityRows: L0TaskActivityRow[];
  activityVisibility: Record<string, 'full' | 'self_only'>;
  complete: {
    members: boolean;
    tasks: boolean;
    agents: boolean;
    assets: boolean;
    chatMemoryAssets: boolean;
    taskAgents: boolean;
    participationLogs: boolean;
    fixedAssets: boolean;
    skills: boolean;
    l0Activity: boolean;
  };
  failedSources: string[];
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
  activities: TaskActivityFact[];
  plans: TaskPlanFact[];
  bindings: AssetBindingFact[];
  warnings: TeamAtlasWarning[];
}

const ACTIVE_ASSET_TYPES = new Set<TeamAtlasNodeType>([
  'skill',
  'llm_wiki',
  'code_graph',
  'chat_memory',
]);
const INACTIVE_STATUSES = new Set(['archived', 'deprecated', 'failed', 'inactive', 'removed']);
const ATLAS_SOURCE_LIMIT = 500;
const ATLAS_TEAM_LIMIT = 4;
const ATLAS_FANOUT_CONCURRENCY = 20;

function nodeId(type: TeamAtlasNodeType, id: string): string {
  return `${type}:${id}`;
}

function edgeId(type: TeamAtlasRelation, source: string, target: string): string {
  return `${type}:${source}->${target}`;
}

function active(status: string | undefined): boolean {
  return !status || !INACTIVE_STATUSES.has(status);
}

export function resolveTaskActivityVisibility(
  userId: string,
  team: TeamRaw,
  role: string | undefined,
  tasks: TaskRaw[],
): Record<string, 'full' | 'self_only'> {
  const canSeeWholeTeam = team.owner_user_id === userId || role === 'admin';
  return Object.fromEntries(tasks.map((task) => [
    task.task_id,
    canSeeWholeTeam || task.creator_user_id === userId ? 'full' : 'self_only',
  ]));
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

export async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...(await Promise.all(items.slice(i, i + batchSize).map(mapper))));
  }
  return out;
}

export function buildTeamAtlasIR(
  userId: string,
  snapshots: TeamAtlasSnapshot[],
  generatedAt = new Date().toISOString(),
  mode: TeamAtlasMode = 'all',
): TeamAtlasIR {
  const nodeById = new Map<string, TeamAtlasNode>();
  const edges: TeamAtlasEdge[] = [];
  const activityEdgeById = new Map<
    string,
    { edge: TeamAtlasEdge; taskIds: Set<string>; activityIds: Set<string> }
  >();
  const activities: TaskActivityFact[] = [];
  const plans: TaskPlanFact[] = [];
  const bindings: AssetBindingFact[] = [];
  const warnings: TeamAtlasWarning[] = [];

  const pushNode = (node: TeamAtlasNode): void => {
    nodeById.set(node.id, node);
  };

  const pushActivityEdge = (edge: TeamAtlasEdge, taskId: string, activityId: string): void => {
    const existing = activityEdgeById.get(edge.id);
    if (!existing) {
      edges.push(edge);
      activityEdgeById.set(edge.id, {
        edge,
        taskIds: new Set([taskId]),
        activityIds: new Set([activityId]),
      });
      return;
    }
    existing.taskIds.add(taskId);
    existing.activityIds.add(activityId);
  };

  for (const snapshot of [...snapshots].sort((a, b) => a.team.team_id.localeCompare(b.team.team_id))) {
    const team = snapshot.team;
    const tasks = snapshot.tasks.filter((item) => active(item.status));
    const agents = snapshot.agents;
    const assets = snapshot.assets.filter(
      (item) => active(item.status) && ACTIVE_ASSET_TYPES.has(item.asset_type),
    );
    const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
    const skillById = new Map(snapshot.skills.map((skill) => [skill.skill_id, skill]));
    const activeSkillOwnerIds = new Set(
      snapshot.skills
        .filter((skill) => skill.owner_agent_id && active(skill.status))
        .map((skill) => skill.owner_agent_id as string),
    );
    const assetByNodeId = new Map(
      assets.map((asset) => [nodeId(asset.asset_type, asset.asset_id), asset]),
    );
    const lastParticipationAtByTask = new Map<string, string>();
    for (const item of snapshot.participationLogs) {
      const timestamp = item.created_at ?? '';
      if (timestamp.localeCompare(lastParticipationAtByTask.get(item.task_id) ?? '') > 0) {
        lastParticipationAtByTask.set(item.task_id, timestamp);
      }
    }
    const visibleNodeIds = new Set<string>();
    const pushVisibleNode = (node: TeamAtlasNode): void => {
      pushNode(node);
      visibleNodeIds.add(node.id);
    };
    const teamNode = nodeId('team', team.team_id);
    pushVisibleNode({
      id: teamNode,
      entity_id: team.team_id,
      type: 'team',
      label: team.name || team.team_id,
      team_id: team.team_id,
      status: team.status,
      metadata: {
        owner_user_id: team.owner_user_id,
        role: snapshot.role ?? null,
        tasks: tasks.length,
        agents: agents.length,
        assets: assets.length,
      },
    });
    const members = snapshot.members.filter((item) => active(item.status));
    const memberNodeId = (memberUserId: string) => nodeId('identity', `${team.team_id}:${memberUserId}`);
    for (const member of members) {
      const id = memberNodeId(member.user_id);
      pushVisibleNode({
        id,
        entity_id: member.user_id,
        type: 'identity',
        label: member.username || member.user_id,
        team_id: team.team_id,
        metadata: {
          role: member.role ?? null,
          is_current: member.user_id === userId,
        },
      });
      edges.push({
        id: edgeId('member_of', teamNode, id),
        type: 'member_of',
        source: teamNode,
        target: id,
        team_id: team.team_id,
      });
    }

    for (const task of tasks) {
      const id = nodeId('task', task.task_id);
      const lastParticipatedAt = lastParticipationAtByTask.get(task.task_id);
      pushVisibleNode({
        id,
        entity_id: task.task_id,
        type: 'task',
        label: task.title || task.task_id,
        team_id: team.team_id,
        status: task.status,
        metadata: {
          creator_user_id: task.creator_user_id ?? null,
          source_type: task.source_type ?? null,
          last_participated_at: lastParticipatedAt || null,
          activity_visibility: snapshot.activityVisibility[task.task_id] ?? 'self_only',
        },
      });
      edges.push({
        id: edgeId('belongs_to', id, teamNode),
        type: 'belongs_to',
        source: id,
        target: teamNode,
        team_id: team.team_id,
        metadata: { relation_kind: 'configured' },
      });
      const creatorNode = task.creator_user_id ? memberNodeId(task.creator_user_id) : '';
      if (visibleNodeIds.has(creatorNode)) {
        edges.push({
          id: edgeId('created_by', id, creatorNode),
          type: 'created_by',
          source: id,
          target: creatorNode,
          team_id: team.team_id,
          metadata: { relation_kind: 'configured' },
        });
      }
    }
    for (const agent of agents) {
      const id = nodeId('agent', agent.agent_id);
      pushVisibleNode({
        id,
        entity_id: agent.agent_id,
        type: 'agent',
        label: agent.name || agent.agent_id,
        team_id: team.team_id,
        status: agent.status,
        metadata: {
          owner_user_id: agent.owner_user_id,
          created_at: agent.created_at ?? null,
        },
      });
      const ownerNode = memberNodeId(agent.owner_user_id);
      if (visibleNodeIds.has(ownerNode)) {
        edges.push({ id: edgeId('owns', ownerNode, id), type: 'owns', source: ownerNode, target: id, team_id: team.team_id });
      }
    }
    for (const asset of assets) {
      const skill = asset.asset_type === 'skill' ? skillById.get(asset.asset_id) : undefined;
      pushVisibleNode({
        id: nodeId(asset.asset_type, asset.asset_id),
        entity_id: asset.asset_id,
        type: asset.asset_type,
        label: asset.name || asset.asset_id,
        team_id: team.team_id,
        status: asset.status,
        metadata: {
          visibility: asset.visibility ?? null,
          owner_user_id: asset.owner_user_id,
          owner_agent_id: skill?.owner_agent_id ?? null,
          registered: true,
          can_read: true,
        },
      });
    }

    for (const link of snapshot.taskAgents.filter((item) => active(item.status))) {
      const source = nodeId('agent', link.agent_id);
      const target = nodeId('task', link.task_id);
      if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
        plans.push({
          id: `plan:${team.team_id}:${link.task_id}:${link.agent_id}`,
          team_id: team.team_id,
          task_id: link.task_id,
          agent_id: link.agent_id,
          ...(link.role_in_task ? { role_in_task: link.role_in_task } : {}),
        });
        edges.push({
          id: edgeId('planned_for', source, target),
          type: 'planned_for',
          source,
          target,
          team_id: team.team_id,
          metadata: {
            relation_kind: 'configured',
            role_in_task: link.role_in_task ?? null,
          },
        });
      }
    }
    const participation = snapshot.participationLogs.filter((item) => visibleNodeIds.has(nodeId('task', item.task_id)));
    const tupleKey = (item: { task_id: string; user_id: string; agent_id: string }) =>
      `${item.task_id}\0${item.user_id}\0${item.agent_id}`;
    const participationByTuple = new Map<string, ParticipationLogRaw[]>();
    for (const item of participation) {
      const key = tupleKey(item);
      const existing = participationByTuple.get(key);
      if (existing) existing.push(item);
      else participationByTuple.set(key, [item]);
    }
    const l0ByTuple = new Map(snapshot.activityRows.map((item) => [tupleKey(item), item]));
    const allTupleKeys = new Set([...participationByTuple.keys(), ...l0ByTuple.keys()]);
    for (const key of [...allTupleKeys].sort()) {
      const l0 = l0ByTuple.get(key);
      const logs = participationByTuple.get(key) ?? [];
      const reference = l0 ?? logs[0];
      if (!reference) continue;
      const taskId = reference.task_id;
      const taskNode = nodeId('task', taskId);
      if (!visibleNodeIds.has(taskNode)) continue;
      const identityNode = memberNodeId(reference.user_id);
      const agentNode = nodeId('agent', reference.agent_id);
      if (!nodeById.has(identityNode)) {
        pushVisibleNode({ id: identityNode, entity_id: reference.user_id, type: 'identity', label: `Missing identity (${reference.user_id})`, team_id: team.team_id, status: 'missing', metadata: { missing: true, is_current: reference.user_id === userId } });
      }
      if (!nodeById.has(agentNode)) {
        pushVisibleNode({ id: agentNode, entity_id: reference.agent_id, type: 'agent', label: `Missing agent (${reference.agent_id})`, team_id: team.team_id, status: 'missing', metadata: { missing: true, owner_user_id: reference.user_id } });
      }

      const ownMemoryId = `chat_memory-${team.team_id}-${reference.agent_id}`;
      const memoryNode = nodeId('chat_memory', ownMemoryId);
      const registeredMemory = assetByNodeId.get(memoryNode);
      const memoryOwnerUserId = registeredMemory?.owner_user_id
        ?? agentById.get(reference.agent_id)?.owner_user_id
        ?? reference.user_id;
      const memoryRegistration = registeredMemory
        ? true
        : snapshot.complete.chatMemoryAssets && memoryOwnerUserId === userId
          ? false
          : null;
      const lastParticipation = logs.reduce<ParticipationLogRaw | undefined>(
        (latest, item) =>
          !latest || (item.created_at ?? '').localeCompare(latest.created_at ?? '') > 0
            ? item
            : latest,
        undefined,
      );
      const lastSeenAt = l0?.last_seen_at ?? lastParticipation?.created_at;
      const activity: TaskActivityFact = {
        id: `activity:${team.team_id}:${taskId}:${reference.user_id}:${reference.agent_id}`,
        team_id: team.team_id,
        task_id: taskId,
        user_id: reference.user_id,
        agent_id: reference.agent_id,
        l0_session_count: l0?.session_count ?? 0,
        l0_message_count: l0?.l0_message_count ?? 0,
        participation_event_count: logs.length,
        ...(l0?.first_seen_at ? { first_seen_at: l0.first_seen_at } : {}),
        ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
        evidence: l0 && logs.length > 0 ? 'l0_and_participation' : l0 ? 'l0_only' : 'participation_only',
        state: l0 ? 'recorded_dialogue' : snapshot.complete.l0Activity ? 'initialized_no_dialogue' : 'initialized_l0_unknown',
        own_chat_memory_id: ownMemoryId,
        chat_memory_registered: memoryRegistration,
        counts_exact: snapshot.complete.l0Activity && snapshot.complete.participationLogs,
      };
      activities.push(activity);

      if (l0) {
        pushVisibleNode({
          id: memoryNode,
          entity_id: ownMemoryId,
          type: 'chat_memory',
          label: registeredMemory?.name || `Chat Memory (${reference.agent_id})`,
          team_id: team.team_id,
          status: registeredMemory?.status ?? 'logical',
          metadata: {
            visibility: registeredMemory?.visibility ?? null,
            owner_user_id: memoryOwnerUserId,
            owner_agent_id: reference.agent_id,
            registered: memoryRegistration,
            can_read: registeredMemory ? true : snapshot.complete.chatMemoryAssets ? false : null,
          },
        });
        const actualMetadata = { relation_kind: 'observed' };
        pushActivityEdge({ id: edgeId('used_in_session', identityNode, agentNode), type: 'used_in_session', source: identityNode, target: agentNode, team_id: team.team_id, metadata: actualMetadata }, taskId, activity.id);
        pushActivityEdge({ id: edgeId('records_to', agentNode, memoryNode), type: 'records_to', source: agentNode, target: memoryNode, team_id: team.team_id, metadata: actualMetadata }, taskId, activity.id);
        pushActivityEdge({ id: edgeId('contains_task_l0', memoryNode, taskNode), type: 'contains_task_l0', source: memoryNode, target: taskNode, team_id: team.team_id, metadata: actualMetadata }, taskId, activity.id);
      } else {
        const initializedMetadata = { relation_kind: 'observed' };
        pushActivityEdge({ id: edgeId('initialized_by', identityNode, taskNode), type: 'initialized_by', source: identityNode, target: taskNode, team_id: team.team_id, metadata: initializedMetadata }, taskId, activity.id);
        pushActivityEdge({ id: edgeId('initialized_on', agentNode, taskNode), type: 'initialized_on', source: agentNode, target: taskNode, team_id: team.team_id, metadata: initializedMetadata }, taskId, activity.id);
      }
    }
    const plannedAgentsByTask = new Map<string, Set<string>>();
    for (const plan of plans) {
      if (plan.team_id !== team.team_id) continue;
      const planned = plannedAgentsByTask.get(plan.task_id) ?? new Set<string>();
      planned.add(nodeId('agent', plan.agent_id));
      plannedAgentsByTask.set(plan.task_id, planned);
    }
    const observedAgentsByTask = new Map<string, Set<string>>();
    for (const activity of activities) {
      if (activity.team_id !== team.team_id) continue;
      const observed = observedAgentsByTask.get(activity.task_id) ?? new Set<string>();
      observed.add(nodeId('agent', activity.agent_id));
      observedAgentsByTask.set(activity.task_id, observed);
    }
    const boundAgentNodeIds = new Set<string>();
    const boundAssetNodeIds = new Set<string>();
    for (const binding of snapshot.fixedAssets) {
      const source = nodeId('agent', binding.agent_id);
      const asset = assetByNodeId.get(nodeId(binding.asset_type as TeamAtlasNodeType, binding.asset_id));
      if (!asset) continue;
      const target = nodeId(asset.asset_type, asset.asset_id);
      if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
        boundAgentNodeIds.add(source);
        boundAssetNodeIds.add(target);
        bindings.push({
          id: `binding:${team.team_id}:${binding.agent_id}:${asset.asset_type}:${asset.asset_id}`,
          team_id: team.team_id,
          agent_id: binding.agent_id,
          asset_id: asset.asset_id,
          asset_type: asset.asset_type,
        });
        edges.push({ id: edgeId('fixed_binding', source, target), type: 'fixed_binding', source, target, team_id: team.team_id });
      }
    }

    if (snapshot.complete.tasks && tasks.length === 0) warnings.push({ code: 'TEAM_WITHOUT_TASKS', node_id: teamNode, message: `${team.name || team.team_id} has no active tasks` });
    if (snapshot.complete.agents && agents.length === 0) warnings.push({ code: 'TEAM_WITHOUT_AGENTS', node_id: teamNode, message: `${team.name || team.team_id} has no active agents` });
    if (snapshot.complete.taskAgents) {
      for (const task of tasks) {
        const id = nodeId('task', task.task_id);
        if (!plannedAgentsByTask.has(task.task_id)) warnings.push({ code: 'TASK_WITHOUT_AGENTS', node_id: id, message: `${task.title || task.task_id} has no assigned agents` });
      }
    }
    if (
      snapshot.complete.taskAgents &&
      snapshot.complete.participationLogs &&
      snapshot.complete.l0Activity
    ) {
      for (const task of tasks) {
        const id = nodeId('task', task.task_id);
        const assignedAgentIds = plannedAgentsByTask.get(task.task_id) ?? new Set<string>();
        const observedAgentIds = observedAgentsByTask.get(task.task_id) ?? new Set<string>();
        if (
          snapshot.activityVisibility[task.task_id] === 'full' &&
          assignedAgentIds.size > 0 &&
          observedAgentIds.size === 0
        ) {
          warnings.push({
            code: 'TASK_WITHOUT_PARTICIPATION',
            node_id: id,
            message: `${task.title || task.task_id} has assigned agents but no observed participation`,
          });
        }
        const unassigned = [...observedAgentIds].filter((agentId) => !assignedAgentIds.has(agentId));
        if (unassigned.length > 0) {
          warnings.push({
            code: 'TASK_PARTICIPATION_UNASSIGNED_AGENT',
            node_id: id,
            message: `${task.title || task.task_id} has participation from ${unassigned.length} unassigned agent(s)`,
          });
        }
      }
    }
    if (
      snapshot.complete.agents &&
      snapshot.complete.fixedAssets &&
      snapshot.complete.skills &&
      snapshot.complete.assets
    ) {
      for (const agent of agents) {
        if (agent.owner_user_id !== userId) continue;
        const id = nodeId('agent', agent.agent_id);
        const ownsSkill = activeSkillOwnerIds.has(agent.agent_id);
        if (!ownsSkill && !boundAgentNodeIds.has(id)) warnings.push({ code: 'AGENT_WITHOUT_REUSABLE_ASSETS', node_id: id, message: `${agent.name || agent.agent_id} has no reusable assets` });
      }
      for (const asset of assets) {
        const id = nodeId(asset.asset_type, asset.asset_id);
        const ownedSkill = asset.asset_type === 'skill' && !!skillById.get(asset.asset_id)?.owner_agent_id;
        if (!ownedSkill && !boundAssetNodeIds.has(id)) warnings.push({ code: 'ASSET_NOT_BOUND', node_id: id, message: `${asset.name || asset.asset_id} is not bound to an agent` });
      }
    }
    for (const source of snapshot.failedSources) warnings.push({ code: 'SOURCE_PARTIAL', source, node_id: teamNode, message: `${source} is unavailable for ${team.name || team.team_id}` });
  }

  for (const { edge, taskIds, activityIds } of activityEdgeById.values()) {
    edge.metadata = {
      ...edge.metadata,
      task_ids: [...taskIds].sort(),
      activity_ids: [...activityIds].sort(),
    };
  }
  const finalNodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(finalNodes.map((node) => node.id));
  const structuralRelations = new Set<TeamAtlasRelation>(['member_of', 'belongs_to', 'created_by']);
  const actualRelations = new Set<TeamAtlasRelation>(['used_in_session', 'records_to', 'contains_task_l0', 'initialized_by', 'initialized_on']);
  const plannedRelations = new Set<TeamAtlasRelation>(['owns', 'planned_for', 'fixed_binding']);
  const modeEdges = edges.filter((edge) =>
    structuralRelations.has(edge.type) || mode === 'all' ||
    (mode === 'actual' && actualRelations.has(edge.type)) ||
    (mode === 'planned' && plannedRelations.has(edge.type)),
  );
  const finalEdges = dedupeById(modeEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  const finalWarnings = warnings.sort((a, b) => `${a.code}:${a.node_id ?? ''}:${a.source ?? ''}`.localeCompare(`${b.code}:${b.node_id ?? ''}:${b.source ?? ''}`));
  const completeness = snapshots.some((snapshot) => snapshot.failedSources.length > 0) ? 'partial' : 'complete';
  return {
    schema_version: 2,
    generated_at: generatedAt,
    mode,
    scope: { user_id: userId, team_ids: snapshots.map((item) => item.team.team_id).sort() },
    completeness,
    summary: {
      teams: finalNodes.filter((node) => node.type === 'team').length,
      tasks: finalNodes.filter((node) => node.type === 'task').length,
      agents: finalNodes.filter((node) => node.type === 'agent').length,
      assets: finalNodes.filter((node) => ACTIVE_ASSET_TYPES.has(node.type)).length,
      edges: finalEdges.length,
      warnings: finalWarnings.length,
    },
    nodes: finalNodes,
    edges: finalEdges,
    activities: activities.sort((a, b) => a.id.localeCompare(b.id)),
    plans: dedupeById(plans),
    bindings: dedupeById(bindings),
    warnings: finalWarnings,
  };
}

interface BoundedItems<T> {
  items: T[];
  complete: boolean;
}

interface FanoutBoundedItems<T> extends BoundedItems<T> {
  hadFailure: boolean;
}

async function fetchBoundedStrict<T>(
  deps: PanelDeps,
  ctx: MetaCallContext,
  action: string,
  body: Record<string, unknown>,
  maxItems = ATLAS_SOURCE_LIMIT,
  startOffset = 0,
): Promise<BoundedItems<T>> {
  const items: T[] = [];
  const pageSize = 100;
  for (let offset = startOffset; offset < startOffset + maxItems; offset += pageSize) {
    const limit = Math.min(pageSize, startOffset + maxItems - offset);
    const env = await deps.metaKernel.invoke(action, { ...body, limit, offset }, ctx);
    if (env.code !== 0) throw env;
    const batch = extractListItems<T>(env);
    items.push(...batch.slice(0, maxItems - items.length));
    const total = (env.data as { total?: number } | null)?.total;
    if (typeof total === 'number') {
      if (startOffset + items.length >= total) return { items, complete: true };
      if (items.length >= maxItems) {
        return { items, complete: total <= startOffset + maxItems };
      }
    } else if (batch.length < limit) {
      return { items, complete: true };
    }
  }
  return { items, complete: false };
}

export async function fetchFanoutBounded<I, T>(
  inputs: I[],
  mapper: (input: I, remaining: number, offset: number) => Promise<BoundedItems<T>>,
  maxItems = ATLAS_SOURCE_LIMIT,
): Promise<FanoutBoundedItems<T>> {
  const itemsByInput = inputs.map(() => [] as T[]);
  const pending = inputs.map((_, index) => ({ index, offset: 0 }));
  let retainedCount = 0;
  let complete = true;
  let hadFailure = false;

  while (pending.length > 0) {
    const batchBudget = maxItems - retainedCount;
    if (batchBudget <= 0) {
      complete = false;
      break;
    }
    const batchSize = Math.min(ATLAS_FANOUT_CONCURRENCY, batchBudget, pending.length);
    const batch = pending.splice(0, batchSize);
    const baseReservation = Math.floor(batchBudget / batch.length);
    const reservationRemainder = batchBudget % batch.length;
    const results = await Promise.all(
      batch.map(async (state, batchIndex) => {
        const reservation = baseReservation + (batchIndex < reservationRemainder ? 1 : 0);
        try {
          return {
            ok: true as const,
            state,
            reservation,
            value: await mapper(inputs[state.index]!, reservation, state.offset),
          };
        } catch {
          return { ok: false as const, state, reservation };
        }
      }),
    );
    for (const result of results) {
      if (!result.ok) {
        complete = false;
        hadFailure = true;
        continue;
      }
      const retained = result.value.items.slice(0, result.reservation);
      itemsByInput[result.state.index]!.push(...retained);
      retainedCount += retained.length;
      if (retained.length < result.value.items.length) {
        complete = false;
        continue;
      }
      if (!result.value.complete) {
        if (retained.length === 0) {
          complete = false;
          continue;
        }
        pending.push({
          index: result.state.index,
          offset: result.state.offset + retained.length,
        });
      }
    }
  }

  return { items: itemsByInput.flat(), complete, hadFailure };
}

async function fetchAllSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
): Promise<BoundedItems<SkillRaw>> {
  const all: SkillRaw[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const env = await deps.skillKernel.invoke('list', {
      user_id: userId,
      team_id: teamId,
      filters: { status: ['active'] },
      pagination: { limit, offset },
    }, ctx);
    if (env.code !== 0) throw env;
    const data = env.data as { items?: SkillRaw[]; total?: number } | null;
    const items = data?.items ?? [];
    all.push(...items.slice(0, ATLAS_SOURCE_LIMIT - all.length));
    const total = data?.total;
    if (typeof total === 'number' && all.length >= total) {
      return { items: all, complete: true };
    }
    if (items.length < limit) return { items: all, complete: true };
    if (all.length >= ATLAS_SOURCE_LIMIT) {
      return {
        items: all,
        complete: typeof total === 'number' && total <= ATLAS_SOURCE_LIMIT,
      };
    }
  }
}

async function settledSource<T>(source: string, fn: () => Promise<T>): Promise<{ source: string; ok: true; value: T } | { source: string; ok: false }> {
  try {
    return { source, ok: true, value: await fn() };
  } catch {
    return { source, ok: false };
  }
}

async function fetchTaskActivity(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  taskIds: string[],
  userId?: string,
): Promise<{ items: L0TaskActivityRow[]; complete: boolean }> {
  if (taskIds.length === 0) return { items: [], complete: true };
  const cred = toKernelCredentials(ctx, { timeoutMs: 20_000 }, { omitUserKey: true });
  const chunks = Array.from({ length: Math.ceil(taskIds.length / 100) }, (_, index) =>
    taskIds.slice(index * 100, index * 100 + 100),
  );
  const responses = await mapInBatches(chunks, 4, async (chunk) => {
    const env = await deps.kernelHttp.postEnvelope<L0TaskActivityResponse>(
      '/v3/topology/task-activity/aggregate',
      { team_id: teamId, task_ids: chunk, ...(userId ? { user_id: userId } : {}) },
      cred,
    );
    if (env.code !== 0 || !env.data) throw env;
    return env.data;
  });
  const items = responses.flatMap((response) => response.items);
  return {
    items: items.slice(0, ATLAS_SOURCE_LIMIT),
    complete:
      items.length <= ATLAS_SOURCE_LIMIT &&
      responses.every((response) => response.completeness === 'complete' && !response.truncated),
  };
}

async function loadTeamSnapshot(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  team: TeamRaw,
): Promise<TeamAtlasSnapshot> {
  const assetTypes: AssetRaw['asset_type'][] = ['skill', 'llm_wiki', 'code_graph', 'chat_memory'];
  const [memberRes, tasksRes, agentsRes, assetSourceResults, skillsRes, participationLogsRes] = await Promise.all([
    settledSource('team-member/list', () => fetchBoundedStrict<TeamMemberRaw>(deps, ctx, 'team-member/list', { team_id: team.team_id })),
    settledSource('task/list', () => fetchBoundedStrict<TaskRaw>(deps, ctx, 'task/list', { team_id: team.team_id })),
    settledSource('agent/list', () => fetchBoundedStrict<AgentRaw>(deps, ctx, 'agent/list', { team_id: team.team_id })),
    Promise.all(assetTypes.map((assetType) => settledSource(
      `asset/list-accessible:${assetType}`,
      () => fetchBoundedStrict<AssetRaw>(deps, ctx, 'asset/list-accessible', {
        user_id: userId,
        team_id: team.team_id,
        asset_type: assetType,
        action: 'read',
      }),
    ))),
    settledSource('skill/list', () => fetchAllSkills(deps, ctx, userId, team.team_id)),
    settledSource('participation-log/list', () => fetchBoundedStrict<ParticipationLogRaw>(deps, ctx, 'participation-log/list', { team_id: team.team_id })),
  ]);
  const tasks = tasksRes.ok ? tasksRes.value.items : [];
  const agents = agentsRes.ok ? agentsRes.value.items : [];
  const members = memberRes.ok ? memberRes.value.items : [];
  const assets = assetSourceResults.flatMap((result) => result.ok ? result.value.items : []);
  const assetsComplete = assetSourceResults.every((result) => result.ok && result.value.complete);
  const role = members.find((member) => member.user_id === userId)?.role;
  const activityVisibility = resolveTaskActivityVisibility(userId, team, role, tasks);
  const fullTaskIds = new Set(tasks.filter((task) => activityVisibility[task.task_id] === 'full').map((task) => task.task_id));
  const selfTaskIds = tasks.map((task) => task.task_id).filter((taskId) => !fullTaskIds.has(taskId));
  const taskAgentsRes = await settledSource('task-agent/list', () =>
    fetchFanoutBounded(tasks, (task, remaining, offset) =>
      fetchBoundedStrict<TaskAgentRaw>(deps, ctx, 'task-agent/list', { task_id: task.task_id }, remaining, offset),
    ),
  );
  const fixedAssetsRes = await settledSource('agent-fixed-asset/list', () =>
    fetchFanoutBounded(agents, async (agent, remaining, offset) => {
      const result = await fetchBoundedStrict<FixedAssetRaw>(deps, ctx, 'agent-fixed-asset/list', { agent_id: agent.agent_id }, remaining, offset);
      return {
        items: result.items.map((binding) => ({ ...binding, agent_id: agent.agent_id })),
        complete: result.complete,
      };
    }),
  );
  const l0ActivityRes = await settledSource('task-activity/aggregate', async () => {
    const [full, self] = await Promise.all([
      fetchTaskActivity(deps, ctx, team.team_id, [...fullTaskIds]),
      fetchTaskActivity(deps, ctx, team.team_id, selfTaskIds, userId),
    ]);
    const items = [...full.items, ...self.items];
    return {
      items: items.slice(0, ATLAS_SOURCE_LIMIT),
      complete: items.length <= ATLAS_SOURCE_LIMIT && full.complete && self.complete,
    };
  });
  const rawActivityRows = l0ActivityRes.ok ? l0ActivityRes.value.items : [];
  const activityRows = rawActivityRows.filter((row) =>
    row.team_id === team.team_id &&
    activityVisibility[row.task_id] !== undefined &&
    (activityVisibility[row.task_id] === 'full' || row.user_id === userId),
  );
  const activityRowsFiltered = activityRows.length !== rawActivityRows.length;
  const boundedSources = [memberRes, tasksRes, agentsRes, skillsRes, participationLogsRes];
  const visibleParticipation = participationLogsRes.ok
    ? participationLogsRes.value.items.filter((log) => fullTaskIds.has(log.task_id) || log.user_id === userId)
    : [];
  return {
    team,
    role,
    members,
    tasks,
    agents,
    assets,
    taskAgents: taskAgentsRes.ok ? taskAgentsRes.value.items : [],
    participationLogs: visibleParticipation,
    fixedAssets: fixedAssetsRes.ok ? fixedAssetsRes.value.items : [],
    skills: skillsRes.ok ? skillsRes.value.items : [],
    activityRows,
    activityVisibility,
    complete: {
      members: memberRes.ok && memberRes.value.complete,
      tasks: tasksRes.ok && tasksRes.value.complete,
      agents: agentsRes.ok && agentsRes.value.complete,
      assets: assetsComplete,
      chatMemoryAssets: assetSourceResults.some((result) =>
        result.source === 'asset/list-accessible:chat_memory' && result.ok && result.value.complete),
      taskAgents:
        tasksRes.ok &&
        tasksRes.value.complete &&
        taskAgentsRes.ok &&
        taskAgentsRes.value.complete,
      participationLogs: participationLogsRes.ok && participationLogsRes.value.complete,
      fixedAssets:
        agentsRes.ok &&
        agentsRes.value.complete &&
        fixedAssetsRes.ok &&
        fixedAssetsRes.value.complete,
      skills: skillsRes.ok && skillsRes.value.complete,
      l0Activity:
        tasksRes.ok &&
        tasksRes.value.complete &&
        l0ActivityRes.ok &&
        l0ActivityRes.value.complete &&
        !activityRowsFiltered,
    },
    failedSources: [
      ...boundedSources.filter((item) => !item.ok).map((item) => item.source),
      ...boundedSources
        .filter((item) => item.ok && !item.value.complete)
        .map((item) => `${item.source}:truncated`),
      ...assetSourceResults.filter((item) => !item.ok).map((item) => item.source),
      ...assetSourceResults
        .filter((item) => item.ok && !item.value.complete)
        .map((item) => `${item.source}:truncated`),
      ...(!taskAgentsRes.ok ? [taskAgentsRes.source] : !taskAgentsRes.value.complete ? [`${taskAgentsRes.source}:partial`] : []),
      ...(!fixedAssetsRes.ok ? [fixedAssetsRes.source] : !fixedAssetsRes.value.complete ? [`${fixedAssetsRes.source}:partial`] : []),
      ...(!l0ActivityRes.ok ? [l0ActivityRes.source] : []),
      ...(l0ActivityRes.ok && !l0ActivityRes.value.complete ? ['task-activity/aggregate:partial'] : []),
      ...(activityRowsFiltered ? ['task-activity/aggregate:acl-filtered'] : []),
    ],
  };
}

async function handleBootstrap(c: Context, deps: PanelDeps): Promise<Response> {
  const ctx = buildCtx(c);
  const body = await readJson(c);
  const requestedTeamIds = [...new Set(strArray(body, 'team_ids'))];
  const requestedMode = typeof body.mode === 'string' ? body.mode : 'all';
  if (requestedTeamIds.length === 0) {
    return respondControlError(c, 400, 'MISSING_TEAM_IDS');
  }
  if (requestedTeamIds.length > ATLAS_TEAM_LIMIT) {
    return respondControlError(c, 400, 'ATLAS_TEAM_LIMIT_EXCEEDED');
  }
  if (!['actual', 'planned', 'all'].includes(requestedMode)) {
    return respondControlError(c, 400, 'INVALID_ATLAS_MODE');
  }
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return respondControlError(c, 401, 'INVALID_USER_KEY');
  let teamError: MetaEnvelope<unknown> | undefined;
  const visibleTeams = (await fetchAllMetaListItems<TeamRaw>(deps, ctx, 'team/list', { user_id: userId }, (env) => { teamError = env; })).filter((team) => active(team.status));
  if (teamError) return respondEnvelope(c, teamError);
  const visibleIds = new Set(visibleTeams.map((team) => team.team_id));
  if (requestedTeamIds.some((teamId) => !visibleIds.has(teamId))) return respondControlError(c, 403, 'TEAM_NOT_VISIBLE');
  const selected = visibleTeams.filter((team) => requestedTeamIds.includes(team.team_id));
  const snapshots = await mapInBatches(selected, 4, (team) => loadTeamSnapshot(deps, ctx, userId, team));
  return respondEnvelope(c, okEnvelope(c, buildTeamAtlasIR(userId, snapshots, new Date().toISOString(), requestedMode as TeamAtlasMode)));
}

export function registerTeamAtlasRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/topology/bootstrap', validatePanelMetaHeaders(deps), (c) => handleBootstrap(c, deps));
}
