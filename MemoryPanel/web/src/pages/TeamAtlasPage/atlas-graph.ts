import type {
  TeamAtlasEdge,
  TeamAtlasIR,
  TeamAtlasNode,
  TeamAtlasNodeType,
  TeamAtlasMode,
} from '../../lib/api/team-atlas';

export interface PositionedAtlasNode extends TeamAtlasNode {
  x: number;
  y: number;
  width: number;
  height: number;
  aggregate_count?: number;
  logical_id?: string;
  parent_agent_id?: string;
}

export interface AtlasProjection {
  nodes: TeamAtlasNode[];
  edges: TeamAtlasEdge[];
  mode: 'full' | 'team_summary' | 'team_detail' | 'agent_focus';
  truncated: boolean;
}

export interface AtlasLayout {
  nodes: PositionedAtlasNode[];
  edges: TeamAtlasEdge[];
  width: number;
  height: number;
}

export interface AtlasEdgeGeometry {
  path: string;
  labelX: number;
  labelY: number;
}

export interface AtlasContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export type AtlasSummaryNodeType =
  'team' | 'task' | 'agent' | 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

export interface AtlasSummaryCard {
  type: AtlasSummaryNodeType;
  mine: number;
  visible: number;
}

const ASSET_TYPES = new Set<TeamAtlasNodeType>(['skill', 'llm_wiki', 'code_graph', 'chat_memory']);
const TYPE_ORDER: Record<TeamAtlasNodeType, number> = {
  team: 0,
  identity: 1,
  agent: 2,
  skill: 3,
  llm_wiki: 4,
  code_graph: 5,
  chat_memory: 6,
  task: 7,
};
const TYPE_X: Record<TeamAtlasNodeType, number> = {
  team: 30,
  identity: 310,
  agent: 600,
  skill: 890,
  llm_wiki: 890,
  code_graph: 890,
  chat_memory: 890,
  task: 1180,
};

export function isAtlasNodeOwnedByCurrent(node: TeamAtlasNode, userId: string): boolean {
  if (node.type === 'identity') return node.metadata?.is_current === true;
  if (node.type === 'task') return node.metadata?.creator_user_id === userId;
  return (
    (node.type === 'team' || node.type === 'agent' || ASSET_TYPES.has(node.type)) &&
    node.metadata?.owner_user_id === userId
  );
}

const SUMMARY_TYPES: AtlasSummaryNodeType[] = [
  'team',
  'task',
  'agent',
  'skill',
  'llm_wiki',
  'code_graph',
  'chat_memory',
];

function stableNodes(nodes: TeamAtlasNode[]): TeamAtlasNode[] {
  return [...nodes].sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (a.team_id ?? '').localeCompare(b.team_id ?? '') ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
}

function connectedIds(edges: TeamAtlasEdge[], ids: Set<string>): Set<string> {
  const out = new Set(ids);
  for (const edge of edges) {
    if (ids.has(edge.source) || ids.has(edge.target)) {
      out.add(edge.source);
      out.add(edge.target);
    }
  }
  return out;
}

export function reconcileAtlasTeamSelection(
  current: string[],
  visibleTeamIds: string[],
  activeTeamId: string | null,
  preferActive: boolean,
  maxTeams = 4,
): string[] {
  const visible = new Set(visibleTeamIds);
  const retained = current.filter((teamId) => visible.has(teamId)).slice(0, maxTeams);
  if (!preferActive && retained.length > 0) return retained;
  const fallback = activeTeamId && visible.has(activeTeamId) ? activeTeamId : visibleTeamIds[0];
  return fallback ? [fallback] : [];
}

export function createAtlasRequestGate() {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (request: number) => request === latest,
  };
}

export function createAtlasEpochGuard() {
  let epoch = 0;
  return {
    capture: () => epoch,
    advance: () => ++epoch,
    isCurrent: (captured: number) => captured === epoch,
  };
}

export function isActiveAtlasTeam(team: { status?: string }): boolean {
  return !team.status || team.status === 'active';
}

export function isAtlasActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function atlasManagementPath(type: TeamAtlasNodeType): string {
  if (type === 'team' || type === 'identity') return '/team/members';
  if (type === 'agent') return '/team/agents';
  if (type === 'skill') return '/skills';
  if (type === 'llm_wiki') return '/wiki';
  if (type === 'code_graph') return '/code';
  if (type === 'chat_memory') return '/memory';
  return '/';
}

function filterEdges(edges: TeamAtlasEdge[], nodes: TeamAtlasNode[]): TeamAtlasEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  return edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function atlasInteractionEdges(edges: TeamAtlasEdge[]): TeamAtlasEdge[] {
  return edges.filter((edge) => edge.type !== 'belongs_to' && edge.type !== 'created_by');
}

export function atlasContentBounds(nodes: PositionedAtlasNode[]): AtlasContentBounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function atlasCanvasSize(
  layout: Pick<AtlasLayout, 'width' | 'height'>,
  nodes: PositionedAtlasNode[],
  padding = 30,
): { width: number; height: number } {
  const bounds = atlasContentBounds(nodes);
  return {
    width: Math.max(1160, layout.width, Math.ceil(bounds.maxX + padding)),
    height: Math.max(620, layout.height, Math.ceil(bounds.maxY + padding)),
  };
}

export function atlasGraphHeight(
  contentHeight: number,
  canvasViewportHeight: number,
  fullscreen: boolean,
): number {
  return fullscreen ? Math.max(contentHeight, canvasViewportHeight) : contentHeight;
}

export function atlasFitViewport(options: {
  areaWidth: number;
  areaHeight: number;
  contentWidth: number;
  contentHeight: number;
  viewScale: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}): { zoom: number; paddingX: number; paddingY: number } {
  const padding = options.padding ?? 14;
  const minZoom = options.minZoom ?? 0.2;
  const maxZoom = options.maxZoom ?? 1.6;
  const viewScale = Math.max(0.001, options.viewScale);
  const widthRatio =
    Math.max(1, options.areaWidth - padding * 2) / Math.max(1, options.contentWidth * viewScale);
  const heightRatio =
    Math.max(1, options.areaHeight - padding * 2) / Math.max(1, options.contentHeight * viewScale);
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(widthRatio, heightRatio)));
  return {
    zoom,
    paddingX: Math.max(padding, (options.areaWidth - options.contentWidth * viewScale * zoom) / 2),
    paddingY: Math.max(
      padding,
      (options.areaHeight - options.contentHeight * viewScale * zoom) / 2,
    ),
  };
}

export function atlasFitArea(options: {
  canvasWidth: number;
  canvasHeight: number;
  viewportHeight: number;
  canvasTop: number;
  fullscreen: boolean;
}): { width: number; height: number } {
  const width = Math.max(1, options.canvasWidth);
  if (options.fullscreen) return { width, height: Math.max(1, options.canvasHeight) };
  return {
    width,
    height: Math.max(
      260,
      Math.min(options.canvasHeight, options.viewportHeight - options.canvasTop - 20),
    ),
  };
}

export function directRelationIds(edges: TeamAtlasEdge[], nodeId: string | undefined): Set<string> {
  if (!nodeId) return new Set();
  const ids = new Set([nodeId]);
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target);
    if (edge.target === nodeId) ids.add(edge.source);
  }
  return ids;
}

export function directVisualNodeIds(
  nodes: PositionedAtlasNode[],
  edges: TeamAtlasEdge[],
  activeNode: PositionedAtlasNode | null,
  mode: TeamAtlasMode = 'all',
): Set<string> {
  if (!activeNode) return new Set();
  const visible = new Set(nodes.map((node) => node.id));
  if (activeNode.type === 'task') {
    return new Set(
      [...taskLineageNodeIds(edges, activeNode, mode)].filter((id) => visible.has(id)),
    );
  }
  return new Set([...directRelationIds(edges, activeNode.id)].filter((id) => visible.has(id)));
}

const ACTUAL_RELATIONS = new Set([
  'used_in_session',
  'records_to',
  'contains_task_l0',
  'initialized_by',
  'initialized_on',
]);

function edgeHasTask(edge: TeamAtlasEdge, taskId: string, taskNodeId: string): boolean {
  if (edge.source === taskNodeId || edge.target === taskNodeId) return true;
  return Array.isArray(edge.metadata?.task_ids) && edge.metadata.task_ids.includes(taskId);
}

export function taskLineageEdgeIds(
  edges: TeamAtlasEdge[],
  taskNode: TeamAtlasNode,
  mode: TeamAtlasMode,
): Set<string> {
  const selected = new Set<string>();
  const agentIds = new Set<string>();
  if (mode !== 'planned') {
    for (const edge of edges) {
      if (!ACTUAL_RELATIONS.has(edge.type) || !edgeHasTask(edge, taskNode.entity_id, taskNode.id))
        continue;
      selected.add(edge.id);
      if (edge.source.startsWith('agent:')) agentIds.add(edge.source);
      if (edge.target.startsWith('agent:')) agentIds.add(edge.target);
    }
  }
  if (mode !== 'actual') {
    for (const edge of edges) {
      if (edge.type !== 'planned_for' || edge.target !== taskNode.id) continue;
      selected.add(edge.id);
      agentIds.add(edge.source);
    }
    for (const edge of edges) {
      if (edge.type === 'owns' && agentIds.has(edge.target)) selected.add(edge.id);
    }
  }
  return selected;
}

export function taskLineageNodeIds(
  edges: TeamAtlasEdge[],
  taskNode: TeamAtlasNode,
  mode: TeamAtlasMode,
): Set<string> {
  const ids = new Set([taskNode.id]);
  const edgeIds = taskLineageEdgeIds(edges, taskNode, mode);
  for (const edge of edges) {
    if (!edgeIds.has(edge.id)) continue;
    ids.add(edge.source);
    ids.add(edge.target);
  }
  return ids;
}

export function projectAtlas(
  ir: TeamAtlasIR,
  options: {
    focusTeamId?: string | null;
    focusAgentId?: string | null;
    query?: string;
    assetType?: TeamAtlasNodeType | 'all';
    teamIds?: string[];
    showUnboundAssets?: boolean;
    showOtherOwners?: boolean;
    maxNodes?: number;
  } = {},
): AtlasProjection {
  const maxNodes = Math.max(1, options.maxNodes ?? 500);
  const focusTeamId = options.focusTeamId ?? undefined;
  let nodes = stableNodes(ir.nodes);
  let mode: AtlasProjection['mode'] = 'full';
  let truncated = false;
  let queryMatches = new Set<string>();
  const bindingEvidencePartial = ir.warnings.some(
    (warning) =>
      warning.code === 'SOURCE_PARTIAL' &&
      ['agent/list', 'asset/list-accessible', 'agent-fixed-asset/list', 'skill/list'].some(
        (source) => warning.source === source || warning.source?.startsWith(`${source}:`),
      ),
  );

  if (options.teamIds) {
    const teamIds = new Set(options.teamIds);
    nodes = nodes.filter((node) => node.team_id && teamIds.has(node.team_id));
  }

  if (options.showUnboundAssets === false && !bindingEvidencePartial) {
    const ownAgentIds = new Set(
      nodes
        .filter(
          (node) => node.type === 'agent' && node.metadata?.owner_user_id === ir.scope.user_id,
        )
        .map((node) => node.id),
    );
    const ownBoundAssetIds = new Set(
      ir.bindings
        .filter((binding) => ownAgentIds.has(`agent:${binding.agent_id}`))
        .map((binding) => `${binding.asset_type}:${binding.asset_id}`),
    );
    for (const node of nodes) {
      if (ASSET_TYPES.has(node.type) && typeof node.metadata?.owner_agent_id === 'string') {
        if (ownAgentIds.has(`agent:${node.metadata.owner_agent_id}`)) ownBoundAssetIds.add(node.id);
      }
    }
    nodes = nodes.filter((node) => !ASSET_TYPES.has(node.type) || ownBoundAssetIds.has(node.id));
  }

  if (options.showOtherOwners === false) {
    nodes = nodes.filter((node) => {
      if (node.type === 'team' || node.type === 'task') return true;
      if (node.type === 'identity') return node.entity_id === ir.scope.user_id;
      return node.metadata?.owner_user_id === ir.scope.user_id;
    });
  }

  const query = options.query?.trim().toLocaleLowerCase();
  if (query) {
    queryMatches = new Set(
      nodes
        .filter((node) => `${node.label} ${node.entity_id}`.toLocaleLowerCase().includes(query))
        .map((node) => node.id),
    );
    const keep = connectedIds(ir.edges, queryMatches);
    for (const node of nodes) {
      if (keep.has(node.id) && node.team_id) keep.add(`team:${node.team_id}`);
    }
    nodes = nodes.filter((node) => keep.has(node.id));
  }
  if (options.assetType && options.assetType !== 'all') {
    nodes = nodes.filter((node) => node.type === options.assetType || !ASSET_TYPES.has(node.type));
  }

  if (options.focusAgentId) {
    const agentNodeId = `agent:${options.focusAgentId}`;
    const ids = connectedIds(ir.edges, new Set([agentNodeId]));
    for (const edge of ir.edges) {
      if (edge.type === 'contains_task_l0' && ids.has(edge.source)) ids.add(edge.target);
    }
    const agent = ir.nodes.find((node) => node.id === agentNodeId);
    if (agent?.team_id) ids.add(`team:${agent.team_id}`);
    nodes = nodes.filter((node) => ids.has(node.id));
    mode = 'agent_focus';
    if (nodes.length > maxNodes) {
      truncated = true;
      nodes = stableNodes(nodes)
        .sort(
          (a, b) =>
            Number(b.id === agentNodeId) - Number(a.id === agentNodeId) ||
            Number(b.type === 'team') - Number(a.type === 'team'),
        )
        .slice(0, maxNodes);
    }
  } else if (focusTeamId) {
    nodes = nodes.filter(
      (node) => node.id === `team:${focusTeamId}` || node.team_id === focusTeamId,
    );
    mode = 'team_detail';
    if (nodes.length > maxNodes) {
      truncated = true;
      const groups = ['skill', 'llm_wiki', 'code_graph', 'chat_memory']
        .flatMap((type) => {
          const count = nodes.filter((node) => node.type === type).length;
          return count === 0
            ? []
            : [
                {
                  id: `aggregate:${focusTeamId}:${type}`,
                  entity_id: `${focusTeamId}:${type}`,
                  type: type as TeamAtlasNodeType,
                  label: `${type} · ${count}`,
                  team_id: focusTeamId,
                  metadata: { aggregate: true, count },
                } satisfies TeamAtlasNode,
              ];
        })
        .slice(0, Math.max(0, maxNodes - 1));
      const structuralBudget = maxNodes - groups.length;
      const structural = [
        ...stableNodes(nodes.filter((node) => node.type === 'team')),
        ...stableNodes(nodes.filter((node) => node.type === 'agent')),
        ...stableNodes(
          nodes.filter((node) => node.type === 'identity' && node.metadata?.is_current === true),
        ),
        ...stableNodes(
          nodes.filter((node) => node.type === 'identity' && node.metadata?.is_current !== true),
        ),
        ...stableNodes(nodes.filter((node) => node.type === 'task')),
      ];
      nodes = stableNodes([...structural.slice(0, structuralBudget), ...groups]);
    }
  } else if (nodes.length > maxNodes) {
    truncated = true;
    if (query) {
      const matchedTeamIds = new Set(
        nodes
          .filter((node) => queryMatches.has(node.id))
          .flatMap((node) => (node.team_id ? [node.team_id] : [])),
      );
      const teamRoots = stableNodes(
        nodes.filter(
          (node) =>
            node.type === 'team' &&
            (queryMatches.has(node.id) || matchedTeamIds.has(node.entity_id)),
        ),
      ).slice(0, maxNodes);
      const retainedTeamIds = new Set(teamRoots.map((node) => node.entity_id));
      const rankedMatches = stableNodes(
        nodes.filter(
          (node) => node.type !== 'team' && (!node.team_id || retainedTeamIds.has(node.team_id)),
        ),
      )
        .sort((a, b) => Number(queryMatches.has(b.id)) - Number(queryMatches.has(a.id)))
        .slice(0, maxNodes - teamRoots.length);
      nodes = stableNodes([...teamRoots, ...rankedMatches]);
    } else {
      const teams = stableNodes(nodes.filter((node) => node.type === 'team'));
      const currentIdentities = stableNodes(
        nodes.filter((node) => node.type === 'identity' && node.metadata?.is_current === true),
      );
      nodes = stableNodes([...teams, ...currentIdentities]).slice(0, maxNodes);
      mode = 'team_summary';
    }
  }

  return { nodes, edges: filterEdges(ir.edges, nodes), mode, truncated };
}

export function summarizeAtlas(ir: TeamAtlasIR, teamIds?: string[]): AtlasSummaryCard[] {
  const selectedTeams = teamIds ? new Set(teamIds) : null;
  const visibleNodes = selectedTeams
    ? ir.nodes.filter((node) => node.team_id && selectedTeams.has(node.team_id))
    : ir.nodes;
  const userId = ir.scope.user_id;
  const ownAgentIds = new Set(
    visibleNodes
      .filter((node) => node.type === 'agent' && node.metadata?.owner_user_id === userId)
      .map((node) => node.id),
  );
  const mine = new Set<string>();

  for (const node of visibleNodes) {
    if (node.type === 'team' && ir.scope.team_ids.includes(node.entity_id)) mine.add(node.id);
    if (node.type === 'task' && node.metadata?.creator_user_id === userId) mine.add(node.id);
    if (node.type === 'agent' && ownAgentIds.has(node.id)) mine.add(node.id);
    if (ASSET_TYPES.has(node.type) && node.metadata?.owner_user_id === userId) mine.add(node.id);
  }

  for (const plan of ir.plans) {
    if (ownAgentIds.has(`agent:${plan.agent_id}`)) mine.add(`task:${plan.task_id}`);
  }
  for (const binding of ir.bindings) {
    if (ownAgentIds.has(`agent:${binding.agent_id}`)) {
      mine.add(`${binding.asset_type}:${binding.asset_id}`);
    }
  }

  return SUMMARY_TYPES.map((type) => {
    const nodes = visibleNodes.filter((node) => node.type === type);
    return { type, mine: nodes.filter((node) => mine.has(node.id)).length, visible: nodes.length };
  });
}

export function taskFactCounts(ir: TeamAtlasIR, taskId: string) {
  const activities = ir.activities.filter((activity) => activity.task_id === taskId);
  const taskTeamId = ir.nodes.find(
    (node) => node.type === 'task' && node.entity_id === taskId,
  )?.team_id;
  const sourceIsPartial = (prefixes: string[]) =>
    ir.warnings.some(
      (warning) =>
        warning.code === 'SOURCE_PARTIAL' &&
        (!taskTeamId || warning.node_id === `team:${taskTeamId}`) &&
        prefixes.some(
          (prefix) => warning.source === prefix || warning.source?.startsWith(`${prefix}:`),
        ),
    );
  return {
    plannedAgents: new Set(
      ir.plans.filter((plan) => plan.task_id === taskId).map((plan) => plan.agent_id),
    ).size,
    activeUsers: new Set(activities.map((activity) => activity.user_id)).size,
    activeAgents: new Set(activities.map((activity) => activity.agent_id)).size,
    sessions: activities.reduce((sum, activity) => sum + activity.l0_session_count, 0),
    messages: activities.reduce((sum, activity) => sum + activity.l0_message_count, 0),
    participationEvents: activities.reduce(
      (sum, activity) => sum + activity.participation_event_count,
      0,
    ),
    countsExact:
      activities.every((activity) => activity.counts_exact) &&
      !sourceIsPartial(['task-activity/aggregate', 'participation-log/list']),
    plannedExact: !sourceIsPartial(['task-agent/list']),
  };
}

export function formatAtlasCount(value: number, exact: boolean): string {
  return `${exact ? '' : '≥'}${value}`;
}

export function layoutAtlas(projection: AtlasProjection): AtlasLayout {
  const width = 1460;
  const nodeWidth = 220;
  const nodeHeight = 72;
  const laneGap = 18;
  const teamGap = 76;
  const positioned: PositionedAtlasNode[] = [];
  let teamTop = 36;
  const teams = stableNodes(projection.nodes.filter((node) => node.type === 'team'));

  for (const team of teams) {
    const teamNodes = stableNodes(
      projection.nodes.filter((node) => node.team_id === team.entity_id),
    );
    const currentUserId = teamNodes.find(
      (node) => node.type === 'identity' && node.metadata?.is_current,
    )?.entity_id;
    const members = teamNodes
      .filter((node) => node.type === 'identity')
      .sort(
        (a, b) =>
          Number(Boolean(b.metadata?.is_current)) - Number(Boolean(a.metadata?.is_current)) ||
          a.label.localeCompare(b.label) ||
          a.id.localeCompare(b.id),
      );
    const agentStatusRank = (node: TeamAtlasNode) =>
      node.status === 'active' ? 0 : node.status === 'inactive' ? 1 : 2;
    const agentCreatedAt = (node: TeamAtlasNode) =>
      typeof node.metadata?.created_at === 'string' && node.metadata.created_at
        ? node.metadata.created_at
        : null;
    const compareAgents = (a: TeamAtlasNode, b: TeamAtlasNode) => {
      const statusOrder = agentStatusRank(a) - agentStatusRank(b);
      if (statusOrder !== 0) return statusOrder;
      const aCreatedAt = agentCreatedAt(a);
      const bCreatedAt = agentCreatedAt(b);
      if (aCreatedAt && bCreatedAt) {
        const createdOrder = aCreatedAt.localeCompare(bCreatedAt);
        if (createdOrder !== 0) return createdOrder;
      } else if (aCreatedAt) return -1;
      else if (bCreatedAt) return 1;
      return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    };
    const agents = teamNodes.filter((node) => node.type === 'agent');
    const memberIds = new Set(members.map((member) => member.entity_id));
    const groupedAgents = new Map<string, TeamAtlasNode[]>();
    for (const agent of agents) {
      const owner = String(agent.metadata?.owner_user_id ?? '');
      const group = groupedAgents.get(owner) ?? [];
      group.push(agent);
      groupedAgents.set(owner, group);
    }
    const identityAgentGroups: Array<{ member?: TeamAtlasNode; agents: TeamAtlasNode[] }> = [
      ...members.map((member) => ({
        member,
        agents: [...(groupedAgents.get(member.entity_id) ?? [])].sort(compareAgents),
      })),
      ...[...groupedAgents.entries()]
        .filter(([owner]) => !memberIds.has(owner))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, ownerAgents]) => ({ agents: [...ownerAgents].sort(compareAgents) })),
    ];
    const tasks = teamNodes
      .filter((node) => node.type === 'task')
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const assets = teamNodes
      .filter((node) => ASSET_TYPES.has(node.type))
      .sort(
        (a, b) =>
          TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
          Number(b.metadata?.owner_user_id === currentUserId) -
            Number(a.metadata?.owner_user_id === currentUserId) ||
          a.label.localeCompare(b.label) ||
          a.id.localeCompare(b.id),
      );
    const laneHeight = (count: number, height: number) =>
      count === 0 ? 0 : count * height + Math.max(0, count - 1) * laneGap;
    const taskLaneHeight = laneHeight(tasks.length, nodeHeight);
    const assetHeight = laneHeight(assets.length, nodeHeight);
    const groupHeights = identityAgentGroups.map(({ agents: ownerAgents }) =>
      Math.max(nodeHeight, laneHeight(ownerAgents.length, nodeHeight)),
    );
    const identityAgentHeight =
      groupHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, groupHeights.length - 1) * laneGap;
    const mainHeight = Math.max(180, identityAgentHeight, assetHeight, taskLaneHeight);
    const blockHeight = mainHeight;
    const teamCenterY = teamTop + mainHeight / 2;

    positioned.push({
      ...team,
      x: TYPE_X.team,
      y: teamCenterY - nodeHeight / 2,
      width: nodeWidth,
      height: nodeHeight,
    });
    let groupTop = teamTop + (mainHeight - identityAgentHeight) / 2;
    identityAgentGroups.forEach((group, groupIndex) => {
      const groupHeight = groupHeights[groupIndex]!;
      if (group.member) {
        positioned.push({
          ...group.member,
          x: TYPE_X.identity,
          y: groupTop + (groupHeight - nodeHeight) / 2,
          width: nodeWidth,
          height: nodeHeight,
        });
      }
      const ownerAgentHeight = laneHeight(group.agents.length, nodeHeight);
      const ownerAgentTop = groupTop + (groupHeight - ownerAgentHeight) / 2;
      group.agents.forEach((agent, index) => {
        positioned.push({
          ...agent,
          x: TYPE_X.agent,
          y: ownerAgentTop + index * (nodeHeight + laneGap),
          width: nodeWidth,
          height: nodeHeight,
        });
      });
      groupTop += groupHeight + laneGap;
    });
    tasks.forEach((task, index) => {
      positioned.push({
        ...task,
        x: TYPE_X.task,
        y: teamTop + (mainHeight - taskLaneHeight) / 2 + index * (nodeHeight + laneGap),
        width: nodeWidth,
        height: nodeHeight,
      });
    });
    const assetStart = teamTop + (mainHeight - assetHeight) / 2;
    assets.forEach((asset, index) => {
      const aggregateCount =
        typeof asset.metadata?.count === 'number' ? asset.metadata.count : undefined;
      positioned.push({
        ...asset,
        x: TYPE_X[asset.type],
        y: assetStart + index * (nodeHeight + laneGap),
        width: nodeWidth,
        height: nodeHeight,
        ...(aggregateCount === undefined ? {} : { aggregate_count: aggregateCount }),
      });
    });
    teamTop += blockHeight + teamGap;
  }

  return {
    nodes: positioned,
    edges: projection.edges,
    width,
    height: Math.max(300, teamTop - teamGap + 36),
  };
}

function edgeSide(
  node: PositionedAtlasNode,
  edge: TeamAtlasEdge,
  nodes: PositionedAtlasNode[],
): 'left' | 'right' {
  const peerId = edge.source === node.id ? edge.target : edge.source;
  const peer = nodes.find((item) => item.id === peerId);
  if (!peer) return 'right';
  return peer.x + peer.width / 2 >= node.x + node.width / 2 ? 'right' : 'left';
}

function edgePortY(
  node: PositionedAtlasNode,
  edge: TeamAtlasEdge,
  edges: TeamAtlasEdge[],
  nodes: PositionedAtlasNode[],
): number {
  const side = edgeSide(node, edge, nodes);
  const incident = edges
    .filter(
      (item) =>
        (item.source === node.id || item.target === node.id) &&
        edgeSide(node, item, nodes) === side,
    )
    .sort((a, b) => {
      const aPeerId = a.source === node.id ? a.target : a.source;
      const bPeerId = b.source === node.id ? b.target : b.source;
      const aPeer = nodes.find((item) => item.id === aPeerId);
      const bPeer = nodes.find((item) => item.id === bPeerId);
      return (aPeer?.y ?? 0) - (bPeer?.y ?? 0) || a.id.localeCompare(b.id);
    });
  const index = incident.findIndex((item) => item.id === edge.id);
  return node.y + (node.height * (index + 1)) / (incident.length + 1);
}

export function edgeGeometry(
  edge: TeamAtlasEdge,
  nodes: PositionedAtlasNode[],
  edges: TeamAtlasEdge[],
): AtlasEdgeGeometry {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return { path: '', labelX: 0, labelY: 0 };
  const sx = edgeSide(source, edge, nodes) === 'right' ? source.x + source.width : source.x;
  const sy = edgePortY(source, edge, edges, nodes);
  const tx = edgeSide(target, edge, nodes) === 'right' ? target.x + target.width : target.x;
  const ty = edgePortY(target, edge, edges, nodes);
  return {
    path: `M ${sx} ${sy} L ${tx} ${ty}`,
    labelX: sx + (tx - sx) / 2,
    labelY: sy + (ty - sy) / 2 - 7,
  };
}

export function edgePath(
  edge: TeamAtlasEdge,
  nodes: PositionedAtlasNode[],
  edges: TeamAtlasEdge[] = [edge],
): string {
  return edgeGeometry(edge, nodes, edges).path;
}
