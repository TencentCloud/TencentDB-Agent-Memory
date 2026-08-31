import { describe, expect, it } from 'vitest';
import { atlasCanvasSize, atlasFitArea, atlasFitViewport, atlasGraphHeight, atlasInteractionEdges, atlasManagementPath, createAtlasEpochGuard, createAtlasRequestGate, directRelationIds, directVisualNodeIds, edgeGeometry, edgePath, formatAtlasCount, isActiveAtlasTeam, isAtlasActivationKey, isAtlasNodeOwnedByCurrent, layoutAtlas, projectAtlas, reconcileAtlasTeamSelection, summarizeAtlas, taskFactCounts, type PositionedAtlasNode } from '../web/src/pages/TeamAtlasPage/atlas-graph.js';
import type { TeamAtlasEdge } from '../web/src/lib/api/team-atlas.js';
import type { TeamAtlasIR, TeamAtlasNode } from '../web/src/lib/api/team-atlas.js';

function irWithNodes(nodes: TeamAtlasNode[]): TeamAtlasIR {
  const teamIds = [...new Set(nodes.map((node) => node.team_id).filter((teamId): teamId is string => Boolean(teamId)))];
  const explicitTeamIds = new Set(nodes.filter((node) => node.type === 'team').map((node) => node.entity_id));
  const teams: TeamAtlasNode[] = teamIds.filter((teamId) => !explicitTeamIds.has(teamId)).map((teamId) => ({ id: `team:${teamId}`, entity_id: teamId, type: 'team', label: teamId, team_id: teamId }));
  const identities: TeamAtlasNode[] = teamIds.map((teamId) => ({ id: `identity:${teamId}:user-1`, entity_id: 'user-1', type: 'identity', label: 'User', team_id: teamId, metadata: { is_current: true } }));
  const edges = teamIds.map((teamId) => ({ id: `member:${teamId}`, type: 'member_of' as const, source: `team:${teamId}`, target: `identity:${teamId}:user-1`, team_id: teamId }));
  return {
    schema_version: 2,
    generated_at: '2026-08-28T00:00:00.000Z',
    mode: 'all',
    scope: { user_id: 'user-1', team_ids: teamIds },
    completeness: 'complete',
    summary: { teams: 0, tasks: 0, agents: 0, assets: 0, edges: edges.length, warnings: 0 },
    nodes: [...identities, ...teams, ...nodes],
    edges,
    activities: [],
    plans: [],
    bindings: [],
    warnings: [],
  };
}

describe('Team Atlas projection and layout', () => {
  it('retains a valid multi-Team selection unless the global active Team changes', () => {
    expect(reconcileAtlasTeamSelection(['a', 'b'], ['a', 'b', 'c'], 'a', false)).toEqual(['a', 'b']);
    expect(reconcileAtlasTeamSelection(['a', 'b'], ['a', 'b', 'c'], 'c', true)).toEqual(['c']);
    expect(reconcileAtlasTeamSelection([], ['a', 'b'], 'a', false)).toEqual(['a']);
  });

  it('allows only the newest topology request to update page state', () => {
    const gate = createAtlasRequestGate();
    const actualRequest = gate.begin();
    const plannedRequest = gate.begin();
    expect(gate.isCurrent(actualRequest)).toBe(false);
    expect(gate.isCurrent(plannedRequest)).toBe(true);
  });

  it('invalidates stale Chat Memory status requests during refresh', () => {
    const guard = createAtlasEpochGuard();
    const beforeRefresh = guard.capture();
    guard.advance();
    expect(guard.isCurrent(beforeRefresh)).toBe(false);
    expect(guard.isCurrent(guard.capture())).toBe(true);
  });

  it('offers only active Teams to the Atlas picker', () => {
    expect(isActiveAtlasTeam({ status: 'active' })).toBe(true);
    expect(isActiveAtlasTeam({ status: 'archived' })).toBe(false);
  });

  it('maps Identity management correctly and supports keyboard activation', () => {
    expect(atlasManagementPath('identity')).toBe('/team/members');
    expect(atlasManagementPath('agent')).toBe('/team/agents');
    expect(isAtlasActivationKey('Enter')).toBe(true);
    expect(isAtlasActivationKey(' ')).toBe(true);
    expect(isAtlasActivationKey('Escape')).toBe(false);
  });

  it('marks only Tasks created by the current Panel user as owned', () => {
    expect(isAtlasNodeOwnedByCurrent(
      { id: 'task:mine', entity_id: 'mine', type: 'task', label: 'Mine', metadata: { creator_user_id: 'user-1' } },
      'user-1',
    )).toBe(true);
    expect(isAtlasNodeOwnedByCurrent(
      { id: 'task:other', entity_id: 'other', type: 'task', label: 'Other', metadata: { creator_user_id: 'user-2' } },
      'user-1',
    )).toBe(false);
  });

  it('switches to a team summary at the 101-node boundary', () => {
    const nodes: TeamAtlasNode[] = Array.from({ length: 100 }, (_, index) => ({ id: `team:team-${index}`, entity_id: `team-${index}`, type: 'team', label: `Team ${index}`, team_id: `team-${index}` }));
    const projection = projectAtlas(irWithNodes(nodes), { maxNodes: 100 });
    expect(projection.mode).toBe('team_summary');
    expect(projection.truncated).toBe(true);
    expect(projection.nodes.length).toBeLessThanOrEqual(100);
    expect(projection.nodes.every((node) => node.type === 'identity' || node.type === 'team')).toBe(true);
  });

  it('uses deterministic positions with no overlap inside a layer', () => {
    const input = irWithNodes([
      { id: 'team:b', entity_id: 'b', type: 'team', label: 'B', team_id: 'b' },
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' },
    ]);
    const first = layoutAtlas(projectAtlas(input));
    const second = layoutAtlas(projectAtlas(input));
    expect(first).toEqual(second);
    const teamNodes = first.nodes.filter((node) => node.type === 'team');
    expect(teamNodes[1]!.y - teamNodes[0]!.y).toBeGreaterThanOrEqual(teamNodes[0]!.height);
  });

  it('lays out all four asset types in one shared lane without overlap', () => {
    const input = irWithNodes([
      { id: 'skill:s', entity_id: 's', type: 'skill', label: 'Skill', team_id: 'team-a' },
      { id: 'llm_wiki:w', entity_id: 'w', type: 'llm_wiki', label: 'Wiki', team_id: 'team-a' },
      { id: 'code_graph:c', entity_id: 'c', type: 'code_graph', label: 'Code', team_id: 'team-a' },
      { id: 'chat_memory:m', entity_id: 'm', type: 'chat_memory', label: 'Memory', team_id: 'team-a' },
    ]);
    const assets = layoutAtlas(projectAtlas(input)).nodes
      .filter((node) => ['skill', 'llm_wiki', 'code_graph', 'chat_memory'].includes(node.type))
      .sort((a, b) => a.y - b.y);
    expect(new Set(assets.map((node) => node.y)).size).toBe(4);
    expect(assets.every((node, index) => index === 0 || node.y - assets[index - 1]!.y >= node.height)).toBe(true);
  });

  it('stacks multiple team hierarchies without vertical overlap', () => {
    const input = irWithNodes([
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' },
      { id: 'team:b', entity_id: 'b', type: 'team', label: 'B', team_id: 'b' },
      { id: 'agent:a', entity_id: 'agent-a', type: 'agent', label: 'Agent A', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:b', entity_id: 'agent-b', type: 'agent', label: 'Agent B', team_id: 'b', metadata: { owner_user_id: 'user-1' } },
    ]);
    const layout = layoutAtlas(projectAtlas(input));
    const first = layout.nodes.filter((node) => node.team_id === 'a');
    const second = layout.nodes.filter((node) => node.team_id === 'b');
    expect(Math.max(...first.map((node) => node.y + node.height))).toBeLessThan(Math.min(...second.map((node) => node.y)));
  });

  it('can hide assets that are not bound to an Agent owned by the current user', () => {
    const input = irWithNodes([
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'team-a' },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'team-a' },
    ]);
    input.mode = 'actual';
    expect(projectAtlas(input, { showUnboundAssets: false }).nodes.some((node) => node.id === 'skill:mine')).toBe(false);
    input.bindings.push(
      { id: 'bind:mine', team_id: 'team-a', agent_id: 'mine', asset_id: 'mine', asset_type: 'skill' },
      { id: 'bind:other', team_id: 'team-a', agent_id: 'other', asset_id: 'other', asset_type: 'skill' },
    );
    const projection = projectAtlas(input, { showUnboundAssets: false });
    expect(projection.nodes.some((node) => node.id === 'skill:mine')).toBe(true);
    expect(projection.nodes.some((node) => node.id === 'skill:other')).toBe(false);
  });

  it('does not classify assets as unbound when binding evidence is partial', () => {
    const input = irWithNodes([
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'skill:unknown', entity_id: 'unknown', type: 'skill', label: 'Unknown', team_id: 'team-a' },
    ]);
    input.completeness = 'partial';
    input.warnings.push({
      code: 'SOURCE_PARTIAL',
      source: 'agent-fixed-asset/list:truncated',
      message: 'binding evidence is truncated',
    });
    expect(
      projectAtlas(input, { showUnboundAssets: false }).nodes.some(
        (node) => node.id === 'skill:unknown',
      ),
    ).toBe(true);
  });

  it('can hide identities, Agents, and assets owned by other users while retaining the Team', () => {
    const input = irWithNodes([
      { id: 'team:team-a', entity_id: 'team-a', type: 'team', label: 'Team A', team_id: 'team-a' },
      { id: 'identity:team-a:user-2', entity_id: 'user-2', type: 'identity', label: 'Other', team_id: 'team-a' },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
    ]);
    input.edges.push({ id: 'member:other', type: 'member_of', source: 'team:team-a', target: 'identity:team-a:user-2' });
    const projection = projectAtlas(input, { showOtherOwners: false });
    expect(projection.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['team:team-a', 'identity:team-a:user-1', 'agent:mine', 'skill:mine']));
    expect(projection.nodes.map((node) => node.id)).not.toEqual(expect.arrayContaining(['identity:team-a:user-2', 'agent:other', 'skill:other']));
  });

  it('sorts the current owner first and horizontally aligns each Identity with its first Agent', () => {
    const input = irWithNodes([
      { id: 'identity:team-a:user-2', entity_id: 'user-2', type: 'identity', label: 'A Other', team_id: 'team-a' },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'A Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Z Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'task:one', entity_id: 'one', type: 'task', label: 'One', team_id: 'team-a' },
      { id: 'task:two', entity_id: 'two', type: 'task', label: 'Two', team_id: 'team-a' },
      { id: 'chat_memory:other', entity_id: 'other-memory', type: 'chat_memory', label: 'A Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'chat_memory:mine', entity_id: 'mine-memory', type: 'chat_memory', label: 'Z Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
    ]);
    input.edges.push(
      { id: 'member:other', type: 'member_of', source: 'team:team-a', target: 'identity:team-a:user-2' },
      { id: 'assigned:one', type: 'planned_for', source: 'agent:mine', target: 'task:one' },
      { id: 'assigned:two', type: 'planned_for', source: 'agent:mine', target: 'task:two' },
    );
    const layout = layoutAtlas(projectAtlas(input));
    const mineIdentity = layout.nodes.find((node) => node.id === 'identity:team-a:user-1')!;
    const mineAgent = layout.nodes.find((node) => node.id === 'agent:mine')!;
    const otherIdentity = layout.nodes.find((node) => node.id === 'identity:team-a:user-2')!;
    const team = layout.nodes.find((node) => node.id === 'team:team-a')!;
    expect(mineIdentity.y).toBeLessThan(otherIdentity.y);
    expect(mineIdentity.y).toBe(mineAgent.y);
    expect(team.y + team.height / 2).toBe((mineIdentity.y + mineIdentity.height / 2 + otherIdentity.y + otherIdentity.height / 2) / 2);
    const memories = layout.nodes.filter((node) => node.type === 'chat_memory').sort((a, b) => a.y - b.y);
    expect(memories[0]!.id).toBe('chat_memory:mine');
  });

  it('keeps owner Agent groups adjacent and sorts them by status and creation time', () => {
    const input = irWithNodes([
      { id: 'identity:team-a:user-2', entity_id: 'user-2', type: 'identity', label: 'Other', team_id: 'team-a' },
      { id: 'agent:mine-inactive', entity_id: 'mine-inactive', type: 'agent', label: 'Inactive', team_id: 'team-a', status: 'inactive', metadata: { owner_user_id: 'user-1', created_at: '2026-08-20T00:00:00.000Z' } },
      { id: 'agent:mine-new', entity_id: 'mine-new', type: 'agent', label: 'New', team_id: 'team-a', status: 'active', metadata: { owner_user_id: 'user-1', created_at: '2026-08-22T00:00:00.000Z' } },
      { id: 'agent:mine-old', entity_id: 'mine-old', type: 'agent', label: 'Old', team_id: 'team-a', status: 'active', metadata: { owner_user_id: 'user-1', created_at: '2026-08-21T00:00:00.000Z' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'team-a', status: 'active', metadata: { owner_user_id: 'user-2' } },
      { id: 'task:t', entity_id: 't', type: 'task', label: 'Task', team_id: 'team-a' },
    ]);
    input.edges.push({ id: 'member:other', type: 'member_of', source: 'team:team-a', target: 'identity:team-a:user-2' });
    const layout = layoutAtlas(projectAtlas(input));
    const agents = layout.nodes.filter((node) => node.type === 'agent').sort((a, b) => a.y - b.y);
    expect(agents.map((agent) => agent.id)).toEqual([
      'agent:mine-old',
      'agent:mine-new',
      'agent:mine-inactive',
      'agent:other',
    ]);
    const mineIdentity = layout.nodes.find((node) => node.id === 'identity:team-a:user-1')!;
    const mineAgents = agents.filter((agent) => agent.metadata?.owner_user_id === 'user-1');
    const meanAgentCenter = mineAgents.reduce((sum, agent) => sum + agent.y + agent.height / 2, 0) / mineAgents.length;
    expect(mineIdentity.y + mineIdentity.height / 2).toBe(meanAgentCenter);
    const task = layout.nodes.find((node) => node.id === 'task:t')!;
    expect(task.x).toBeGreaterThan(Math.max(...agents.map((agent) => agent.x + agent.width)));
  });

  it('renders one canonical Task node with visible edges to every assigned Agent', () => {
    const input = irWithNodes([
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'Agent A', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:b', entity_id: 'b', type: 'agent', label: 'Agent B', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'task:t', entity_id: 't', type: 'task', label: 'Task', team_id: 'team-a' },
    ]);
    input.edges.push(
      { id: 'assigned:a', type: 'planned_for', source: 'agent:a', target: 'task:t' },
      { id: 'assigned:b', type: 'planned_for', source: 'agent:b', target: 'task:t' },
    );
    const layout = layoutAtlas(projectAtlas(input));
    const tasks = layout.nodes.filter((node) => node.type === 'task');
    const agents = layout.nodes.filter((node) => node.type === 'agent');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('task:t');
    expect(agents.every((agent) => tasks[0]!.x > agent.x)).toBe(true);
    expect(edgeGeometry(layout.edges.find((edge) => edge.id === 'assigned:a')!, layout.nodes, layout.edges).path).not.toBe('');
  });

  it('summarizes mine versus visible entities for all seven card types', () => {
    const input = irWithNodes([
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'Team A', team_id: 'a' },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'task:mine', entity_id: 'mine', type: 'task', label: 'Mine', team_id: 'a', metadata: { creator_user_id: 'user-2' } },
      { id: 'task:other', entity_id: 'other', type: 'task', label: 'Other', team_id: 'a', metadata: { creator_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'llm_wiki:mine', entity_id: 'mine', type: 'llm_wiki', label: 'Wiki', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'code_graph:other', entity_id: 'other', type: 'code_graph', label: 'Code', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'chat_memory:mine', entity_id: 'mine', type: 'chat_memory', label: 'Memory', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
    ]);
    input.plans.push(
      { id: 'assigned:mine', team_id: 'a', agent_id: 'mine', task_id: 'mine' },
      { id: 'assigned:other', team_id: 'a', agent_id: 'other', task_id: 'other' },
    );
    input.bindings.push(
      { id: 'binding:mine', team_id: 'a', agent_id: 'mine', asset_id: 'mine', asset_type: 'skill' },
    );
    expect(summarizeAtlas(input)).toEqual([
      { type: 'team', mine: 1, visible: 1 },
      { type: 'task', mine: 1, visible: 2 },
      { type: 'agent', mine: 1, visible: 2 },
      { type: 'skill', mine: 1, visible: 2 },
      { type: 'llm_wiki', mine: 1, visible: 1 },
      { type: 'code_graph', mine: 0, visible: 1 },
      { type: 'chat_memory', mine: 1, visible: 1 },
    ]);
  });

  it('keeps planned Task counts available when Actual mode omits planned edges', () => {
    const input = irWithNodes([
      { id: 'task:t', entity_id: 't', type: 'task', label: 'Task', team_id: 'a' },
    ]);
    input.mode = 'actual';
    input.plans.push(
      { id: 'plan:a', team_id: 'a', task_id: 't', agent_id: 'a' },
      { id: 'plan:b', team_id: 'a', task_id: 't', agent_id: 'b' },
    );
    expect(input.edges.some((edge) => edge.type === 'planned_for')).toBe(false);
    expect(taskFactCounts(input, 't').plannedAgents).toBe(2);
  });

  it('marks capped Task activity counts as lower bounds', () => {
    const input = irWithNodes([{ id: 'task:t', entity_id: 't', type: 'task', label: 'Task', team_id: 'a' }]);
    input.activities.push({
      id: 'activity:a:t:user-1:agent-1', team_id: 'a', task_id: 't', user_id: 'user-1', agent_id: 'agent-1',
      l0_session_count: 3, l0_message_count: 7, participation_event_count: 2,
      evidence: 'l0_and_participation', state: 'recorded_dialogue', own_chat_memory_id: 'memory-1',
      chat_memory_registered: true, counts_exact: false,
    });
    const counts = taskFactCounts(input, 't');
    expect(counts).toMatchObject({ sessions: 3, messages: 7, countsExact: false });
    expect(formatAtlasCount(counts.messages, counts.countsExact)).toBe('≥7');
  });

  it('applies search before the 500-node summary cutoff and supports Team and Agent focus', () => {
    const nodes: TeamAtlasNode[] = [
      { id: 'agent:needle', entity_id: 'needle', type: 'agent', label: 'Needle Agent', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      ...Array.from({ length: 510 }, (_, index) => ({
        id: `skill:${index}`,
        entity_id: String(index),
        type: 'skill' as const,
        label: `Skill ${index}`,
        team_id: 'a',
      })),
    ];
    const input = irWithNodes(nodes);
    input.nodes.push(
      { id: 'chat_memory:needle', entity_id: 'needle-memory', type: 'chat_memory', label: 'Needle Memory', team_id: 'a' },
      { id: 'task:needle', entity_id: 'needle-task', type: 'task', label: 'Needle Task', team_id: 'a' },
    );
    input.edges.push(
      { id: 'records:needle', type: 'records_to', source: 'agent:needle', target: 'chat_memory:needle' },
      { id: 'contains:needle', type: 'contains_task_l0', source: 'chat_memory:needle', target: 'task:needle' },
    );
    const searched = projectAtlas(input, { query: 'Needle Agent', maxNodes: 100 });
    expect(searched.mode).toBe('full');
    expect(searched.nodes.length).toBeLessThanOrEqual(100);
    expect(searched.nodes.some((node) => node.id === 'agent:needle')).toBe(true);
    expect(searched.nodes.some((node) => node.id === 'team:a')).toBe(true);
    expect(layoutAtlas(searched).nodes.some((node) => node.id === 'agent:needle')).toBe(true);
    const teamFocus = projectAtlas(input, { focusTeamId: 'a', maxNodes: 100 });
    expect(teamFocus.mode).toBe('team_detail');
    expect(teamFocus.nodes.length).toBeLessThanOrEqual(100);
    expect(teamFocus.nodes.some((node) => node.id === 'agent:needle')).toBe(true);
    const agentFocus = projectAtlas(input, { focusAgentId: 'needle', maxNodes: 100 });
    expect(agentFocus.mode).toBe('agent_focus');
    expect(agentFocus.nodes.length).toBeLessThanOrEqual(100);
    expect(agentFocus.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      'agent:needle',
      'chat_memory:needle',
      'task:needle',
    ]));
  });

  it('reserves the Team root when more query matches exist than the node budget', () => {
    const input = irWithNodes(Array.from({ length: 150 }, (_, index) => ({
      id: `skill:matching-${index}`, entity_id: `matching-${index}`, type: 'skill' as const,
      label: `Matching asset ${index}`, team_id: 'a',
    })));
    const projection = projectAtlas(input, { query: 'Matching asset', maxNodes: 100 });
    expect(projection.truncated).toBe(true);
    expect(projection.nodes).toHaveLength(100);
    expect(projection.nodes.some((node) => node.id === 'team:a')).toBe(true);
    expect(projection.nodes.filter((node) => node.type === 'skill')).toHaveLength(99);
    expect(layoutAtlas(projection).nodes.some((node) => node.id === 'team:a')).toBe(true);
  });

  it('keeps Team drill-down reachable when structural nodes exceed the node budget', () => {
    const nodes: TeamAtlasNode[] = [
      { id: 'agent:reachable', entity_id: 'reachable', type: 'agent', label: 'Reachable', team_id: 'a' },
      ...Array.from({ length: 600 }, (_, index) => ({
        id: `identity:a:user-${index}`,
        entity_id: `user-${index}`,
        type: 'identity' as const,
        label: `User ${index}`,
        team_id: 'a',
      })),
    ];
    const input = irWithNodes(nodes);
    const summary = projectAtlas(input, { maxNodes: 100 });
    expect(summary.mode).toBe('team_summary');
    expect(summary.nodes.length).toBeLessThanOrEqual(100);
    expect(summary.nodes.some((node) => node.id === 'team:a')).toBe(true);
    const detail = projectAtlas(input, { focusTeamId: 'a', maxNodes: 100 });
    expect(detail.nodes.length).toBeLessThanOrEqual(100);
    expect(detail.nodes.some((node) => node.id === 'agent:reachable')).toBe(true);
  });

  it('builds straight edge paths and omits dangling edges', () => {
    const input = irWithNodes([{ id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' }]);
    input.edges.push({ id: 'dangling', type: 'planned_for', source: 'agent:missing', target: 'task:missing' });
    const projection = projectAtlas(input);
    const layout = layoutAtlas(projection);
    expect(projection.edges.some((edge) => edge.id === 'dangling')).toBe(false);
    expect(edgePath(layout.edges[0]!, layout.nodes)).toMatch(/^M .* L /);
    expect(edgePath(layout.edges[0]!, layout.nodes)).not.toMatch(/[HV]/);
  });

  it('uses distinct ports for multiple relationships on the same pair of cards', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'Agent', x: 0, y: 0, width: 230, height: 76 },
      { id: 'skill:s', entity_id: 's', type: 'skill', label: 'Skill', x: 330, y: 0, width: 230, height: 76 },
    ];
    const edges: TeamAtlasEdge[] = [
      { id: 'planned', type: 'planned_for', source: 'agent:a', target: 'skill:s' },
      { id: 'initialized', type: 'initialized_on', source: 'agent:a', target: 'skill:s' },
    ];
    expect(edgeGeometry(edges[0]!, nodes, edges).path).not.toBe(edgeGeometry(edges[1]!, nodes, edges).path);
  });

  it('omits redundant semantic edges from canvas interaction while keeping fixed bindings', () => {
    const edges: TeamAtlasEdge[] = [
      { id: 'owns', type: 'owns', source: 'agent:a', target: 'skill:s' },
      { id: 'belongs', type: 'belongs_to', source: 'task:t', target: 'team:t' },
      { id: 'creator', type: 'created_by', source: 'task:t', target: 'identity:u' },
      { id: 'binding', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
    ];
    expect(atlasInteractionEdges(edges)).toEqual([edges[0], edges[3]]);
  });

  it('highlights only the selected node and its direct parents and children', () => {
    const edges: TeamAtlasEdge[] = [
      { id: 'team-member', type: 'member_of', source: 'team:t', target: 'identity:u' },
      { id: 'member-agent', type: 'owns', source: 'identity:u', target: 'agent:a' },
      { id: 'agent-asset', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
      { id: 'sibling-agent', type: 'owns', source: 'identity:u', target: 'agent:b' },
    ];
    expect([...directRelationIds(edges, 'agent:a')].sort()).toEqual(['agent:a', 'identity:u', 'skill:s']);
    expect(directRelationIds(edges, 'agent:a').has('team:t')).toBe(false);
    expect(directRelationIds(edges, 'agent:a').has('agent:b')).toBe(false);
  });

  it('highlights the canonical Task and all directly assigned Agents', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'A', x: 0, y: 0, width: 220, height: 72 },
      { id: 'agent:b', entity_id: 'b', type: 'agent', label: 'B', x: 0, y: 100, width: 220, height: 72 },
      { id: 'task:t', entity_id: 't', type: 'task', label: 'T', x: 240, y: 50, width: 220, height: 56 },
    ];
    const edges: TeamAtlasEdge[] = [
      { id: 'assigned:a', type: 'planned_for', source: 'agent:a', target: 'task:t' },
      { id: 'assigned:b', type: 'planned_for', source: 'agent:b', target: 'task:t' },
    ];
    expect([...directVisualNodeIds(nodes, edges, nodes[0]!)].sort()).toEqual(['agent:a', 'task:t']);
    expect([...directVisualNodeIds(nodes, edges, nodes[2]!)].sort()).toEqual(['agent:a', 'agent:b', 'task:t']);
  });

  it('recursively highlights Task L0 lineage without following fixed bindings', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'identity:t:u', entity_id: 'u', type: 'identity', label: 'U', x: 0, y: 0, width: 220, height: 72 },
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'A', x: 250, y: 0, width: 220, height: 72 },
      { id: 'chat_memory:m', entity_id: 'm', type: 'chat_memory', label: 'M', x: 500, y: 0, width: 220, height: 72 },
      { id: 'skill:s', entity_id: 's', type: 'skill', label: 'S', x: 500, y: 100, width: 220, height: 72 },
      { id: 'task:t', entity_id: 't', type: 'task', label: 'T', x: 750, y: 0, width: 220, height: 72 },
      { id: 'task:sibling', entity_id: 'sibling', type: 'task', label: 'Sibling', x: 750, y: 100, width: 220, height: 72 },
    ];
    const metadata = { task_ids: ['t'] };
    const edges: TeamAtlasEdge[] = [
      { id: 'used', type: 'used_in_session', source: 'identity:t:u', target: 'agent:a', metadata },
      { id: 'records', type: 'records_to', source: 'agent:a', target: 'chat_memory:m', metadata },
      { id: 'contains', type: 'contains_task_l0', source: 'chat_memory:m', target: 'task:t', metadata },
      { id: 'binding', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
      { id: 'sibling', type: 'contains_task_l0', source: 'chat_memory:m', target: 'task:sibling', metadata: { task_ids: ['sibling'] } },
    ];
    expect([...directVisualNodeIds(nodes, edges, nodes[4]!, 'actual')].sort()).toEqual([
      'agent:a',
      'chat_memory:m',
      'identity:t:u',
      'task:t',
    ]);
  });

  it('expands the SVG canvas when a dragged Team moves nodes below the initial layout', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'A', x: 30, y: 900, width: 220, height: 72 },
      { id: 'identity:u', entity_id: 'u', type: 'identity', label: 'U', x: 310, y: 960, width: 220, height: 72 },
    ];
    expect(atlasCanvasSize({ width: 1210, height: 774 }, nodes)).toEqual({ width: 1210, height: 1062 });
  });

  it('fits fullscreen content to the Canvas client box after classic scrollbars take space', () => {
    expect(atlasGraphHeight(838, 920, true)).toBe(920);
    expect(atlasGraphHeight(1062, 920, true)).toBe(1062);
    expect(atlasGraphHeight(838, 920, false)).toBe(838);
    const fitted = atlasFitViewport({ areaWidth: 1516, areaHeight: 926, contentWidth: 1120, contentHeight: 766, viewScale: 1 });
    expect(fitted.zoom).toBeCloseTo(898 / 766);
    expect(fitted.zoom).toBeGreaterThan(1);
    expect(fitted.paddingY).toBeCloseTo(14);
    expect(fitted.paddingX).toBeGreaterThan(14);
    expect(atlasFitViewport({ areaWidth: 1516, areaHeight: 926, contentWidth: 200, contentHeight: 100, viewScale: 1 }).zoom).toBe(1.6);
    expect(atlasFitArea({ canvasWidth: 889, canvasHeight: 909, viewportHeight: 926, canvasTop: 0, fullscreen: true }))
      .toEqual({ width: 889, height: 909 });
    expect(atlasFitArea({ canvasWidth: 640, canvasHeight: 774, viewportHeight: 710, canvasTop: 320, fullscreen: false }))
      .toEqual({ width: 640, height: 370 });
  });

  it('evenly divides same-side ports across incoming and outgoing edges', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'task:t', entity_id: 't', type: 'task', label: 'Task', x: 0, y: 0, width: 220, height: 72 },
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'Agent', x: 310, y: 100, width: 220, height: 72 },
    ];
    const edges: TeamAtlasEdge[] = [
      { id: 'created', type: 'created_by', source: 'task:t', target: 'agent:a' },
      { id: 'planned', type: 'planned_for', source: 'agent:a', target: 'task:t' },
    ];
    const agentPorts = edges.map((edge) => edgeGeometry(edge, nodes, edges).path).map((path, index) => {
      const numbers = path.match(/-?[\d.]+/g)!.map(Number);
      return index === 0 ? numbers[3] : numbers[1];
    }).sort((a, b) => a - b);
    expect(agentPorts).toEqual([124, 148]);
  });
});
