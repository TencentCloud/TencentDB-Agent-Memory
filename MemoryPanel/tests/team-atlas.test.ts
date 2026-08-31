import { describe, expect, it, vi } from 'vitest';
import {
  buildTeamAtlasIR,
  fetchFanoutBounded,
  mapInBatches,
  resolveTaskActivityVisibility,
  type TeamAtlasSnapshot,
} from '../src/panel/http/routes/team-atlas.js';

function snapshot(overrides: Partial<TeamAtlasSnapshot> = {}): TeamAtlasSnapshot {
  return {
    team: { team_id: 'team-1', name: 'Atlas', owner_user_id: 'user-1' },
    role: 'admin',
    members: [{ user_id: 'user-1', username: 'alice', role: 'admin', status: 'active' }],
    tasks: [{ task_id: 'task-1', team_id: 'team-1', title: 'Ship Atlas', status: 'active', creator_user_id: 'user-1', source_type: 'manual' }],
    agents: [{ agent_id: 'agt-1', team_id: 'team-1', owner_user_id: 'user-1', name: 'Codex', status: 'active', created_at: '2026-08-27T00:00:00.000Z' }],
    assets: [{ asset_id: 'skill-1', team_id: 'team-1', asset_type: 'skill', name: 'Planner', owner_user_id: 'user-1', status: 'active' }],
    taskAgents: [{ task_id: 'task-1', agent_id: 'agt-1', role_in_task: 'implementer', status: 'active' }],
    participationLogs: [{ task_id: 'task-1', agent_id: 'agt-1', user_id: 'user-1', source: 'context_proxy:codex', created_at: '2026-08-28T01:00:00.000Z' }],
    fixedAssets: [],
    skills: [{ skill_id: 'skill-1', owner_agent_id: 'agt-1', status: 'active' }],
    activityRows: [{
      team_id: 'team-1', task_id: 'task-1', user_id: 'user-1', agent_id: 'agt-1',
      session_count: 1, l0_message_count: 2,
      first_seen_at: '2026-08-28T00:59:00.000Z', last_seen_at: '2026-08-28T01:01:00.000Z',
    }],
    activityVisibility: { 'task-1': 'full' },
    complete: { members: true, tasks: true, agents: true, assets: true, chatMemoryAssets: true, taskAgents: true, participationLogs: true, fixedAssets: true, skills: true, l0Activity: true },
    failedSources: [],
    ...overrides,
  };
}

describe('buildTeamAtlasIR', () => {
  it('creates stable namespaced nodes and no dangling edges', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot()], '2026-08-28T00:00:00.000Z');
    const ids = new Set(ir.nodes.map((node) => node.id));
    expect(ir.completeness).toBe('complete');
    expect(ir.nodes.map((node) => node.id)).toEqual([
      'agent:agt-1',
      'chat_memory:chat_memory-team-1-agt-1',
      'identity:team-1:user-1',
      'skill:skill-1',
      'task:task-1',
      'team:team-1',
    ]);
    expect(ir.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(ir.schema_version).toBe(2);
    expect(ir.edges.some((edge) => edge.type === 'planned_for')).toBe(true);
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'belongs_to', source: 'task:task-1', target: 'team:team-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'created_by', source: 'task:task-1', target: 'identity:team-1:user-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'used_in_session', source: 'identity:team-1:user-1', target: 'agent:agt-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'records_to', source: 'agent:agt-1', target: 'chat_memory:chat_memory-team-1-agt-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'contains_task_l0', source: 'chat_memory:chat_memory-team-1-agt-1', target: 'task:task-1' }));
    expect(ir.edges.find((edge) => edge.type === 'planned_for')?.metadata).toMatchObject({ relation_kind: 'configured', role_in_task: 'implementer' });
    expect(ir.edges.some((edge) => edge.type === 'owns')).toBe(true);
    expect(ir.edges.some((edge) => edge.source.startsWith('task:') && edge.target.startsWith('skill:'))).toBe(false);
    expect(ir.nodes.find((node) => node.id === 'team:team-1')?.metadata?.owner_user_id).toBe('user-1');
    expect(ir.nodes.find((node) => node.id === 'task:task-1')?.metadata).toMatchObject({ creator_user_id: 'user-1', source_type: 'manual', last_participated_at: '2026-08-28T01:00:00.000Z', activity_visibility: 'full' });
    expect(ir.nodes.find((node) => node.id === 'agent:agt-1')?.metadata).toMatchObject({
      owner_user_id: 'user-1',
      created_at: '2026-08-27T00:00:00.000Z',
    });
    expect(ir.nodes.find((node) => node.id === 'identity:team-1:user-1')?.metadata).toMatchObject({ role: 'admin', is_current: true });
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'member_of', source: 'team:team-1', target: 'identity:team-1:user-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'owns', source: 'identity:team-1:user-1', target: 'agent:agt-1' }));
    expect(ir.activities).toContainEqual(expect.objectContaining({
      evidence: 'l0_and_participation', state: 'recorded_dialogue', l0_session_count: 1,
      l0_message_count: 2, participation_event_count: 1, chat_memory_registered: false,
    }));
    expect(ir.plans).toEqual([
      expect.objectContaining({ team_id: 'team-1', task_id: 'task-1', agent_id: 'agt-1', role_in_task: 'implementer' }),
    ]);
    expect(ir.warnings).toEqual([]);
  });

  it('does not infer empty-state warnings from failed sources', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      tasks: [],
      taskAgents: [],
      complete: { members: true, tasks: false, agents: true, assets: true, chatMemoryAssets: true, taskAgents: false, participationLogs: true, fixedAssets: true, skills: true, l0Activity: true },
      failedSources: ['task/list'],
    })]);
    expect(ir.completeness).toBe('partial');
    expect(ir.warnings.some((warning) => warning.code === 'SOURCE_PARTIAL')).toBe(true);
    expect(ir.warnings.some((warning) => warning.code === 'TEAM_WITHOUT_TASKS')).toBe(false);
  });

  it('does not infer missing participation or bindings from partial evidence', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      participationLogs: [],
      activityRows: [],
      fixedAssets: [],
      skills: [],
      complete: {
        ...snapshot().complete,
        fixedAssets: false,
        l0Activity: false,
      },
      failedSources: [
        'agent-fixed-asset/list:truncated',
        'task-activity/aggregate:partial',
      ],
    })]);
    expect(ir.warnings.some((warning) => warning.code === 'TASK_WITHOUT_PARTICIPATION')).toBe(false);
    expect(ir.warnings.some((warning) => warning.code === 'AGENT_WITHOUT_REUSABLE_ASSETS')).toBe(false);
    expect(ir.warnings.some((warning) => warning.code === 'ASSET_NOT_BOUND')).toBe(false);
  });

  it('does not infer no participation from a self-only activity view', () => {
    const base = snapshot({ participationLogs: [], activityRows: [] });
    const full = buildTeamAtlasIR('user-1', [base]);
    const selfOnly = buildTeamAtlasIR('user-1', [{
      ...base,
      role: 'member',
      activityVisibility: { 'task-1': 'self_only' },
    }]);
    expect(full.warnings.some((warning) => warning.code === 'TASK_WITHOUT_PARTICIPATION')).toBe(true);
    expect(selfOnly.warnings.some((warning) => warning.code === 'TASK_WITHOUT_PARTICIPATION')).toBe(false);
  });

  it('marks activity counts inexact when Participation is partial', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      complete: { ...snapshot().complete, participationLogs: false },
      failedSources: ['participation-log/list:truncated'],
    })]);
    expect(ir.activities[0]).toMatchObject({ counts_exact: false });
  });

  it('keeps Chat Memory registration unknown when its asset source is partial', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      assets: [],
      complete: { ...snapshot().complete, assets: false, chatMemoryAssets: false },
      failedSources: ['asset/list-accessible:chat_memory'],
    })]);
    expect(ir.activities[0]).toMatchObject({ chat_memory_registered: null });
    expect(ir.nodes.find((node) => node.type === 'chat_memory')?.metadata).toMatchObject({ registered: null, can_read: null });
  });

  it('does not infer another owner private Chat Memory or reusable assets are absent', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      members: [
        { user_id: 'user-1', username: 'alice', role: 'admin', status: 'active' },
        { user_id: 'user-2', username: 'bob', role: 'member', status: 'active' },
      ],
      agents: [{ agent_id: 'agt-private', team_id: 'team-1', owner_user_id: 'user-2', name: 'Private worker', status: 'active' }],
      assets: [],
      taskAgents: [{ task_id: 'task-1', agent_id: 'agt-private', status: 'active' }],
      participationLogs: [], fixedAssets: [], skills: [],
      activityRows: [{
        team_id: 'team-1', task_id: 'task-1', user_id: 'user-2', agent_id: 'agt-private',
        session_count: 1, l0_message_count: 1,
      }],
    })]);
    expect(ir.activities[0]).toMatchObject({ chat_memory_registered: null });
    expect(ir.nodes.find((node) => node.id === 'chat_memory:chat_memory-team-1-agt-private')?.metadata)
      .toMatchObject({ registered: null, can_read: false, owner_user_id: 'user-2' });
    expect(ir.warnings.some((warning) =>
      warning.code === 'AGENT_WITHOUT_REUSABLE_ASSETS' && warning.node_id === 'agent:agt-private'))
      .toBe(false);
  });

  it('preserves visible Chat Memory metadata when runtime activity enriches its node', () => {
    const memoryId = 'chat_memory-team-1-agt-1';
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      assets: [
        ...snapshot().assets,
        { asset_id: memoryId, team_id: 'team-1', asset_type: 'chat_memory', name: 'Private memory', owner_user_id: 'user-1', status: 'active', visibility: 'private' },
      ],
    })]);
    expect(ir.nodes.find((node) => node.id === `chat_memory:${memoryId}`)).toMatchObject({
      label: 'Private memory',
      metadata: { visibility: 'private', registered: true, can_read: true, owner_agent_id: 'agt-1' },
    });
  });

  it('keeps inactive Agents visible with their creation time', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      agents: [{
        agent_id: 'agt-inactive',
        team_id: 'team-1',
        owner_user_id: 'user-1',
        name: 'Archived worker',
        status: 'inactive',
        created_at: '2026-08-26T00:00:00.000Z',
      }],
      taskAgents: [], participationLogs: [], fixedAssets: [], skills: [], activityRows: [],
    })]);
    expect(ir.nodes.find((node) => node.id === 'agent:agt-inactive')).toMatchObject({
      status: 'inactive',
      metadata: { owner_user_id: 'user-1', created_at: '2026-08-26T00:00:00.000Z' },
    });
  });

  it('creates a separate member node for the same user in each team', () => {
    const second = snapshot({
      team: { team_id: 'team-2', name: 'Beta', owner_user_id: 'user-1' },
      tasks: [], agents: [], assets: [], taskAgents: [], participationLogs: [], skills: [],
    });
    const ir = buildTeamAtlasIR('user-1', [snapshot(), second]);
    expect(ir.nodes.filter((node) => node.type === 'identity').map((node) => node.id)).toEqual([
      'identity:team-1:user-1',
      'identity:team-2:user-1',
    ]);
  });

  it('filters links that point to invisible assets', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      assets: [],
      fixedAssets: [{ agent_id: 'agt-1', asset_id: 'private-asset', asset_type: 'llm_wiki' }],
      skills: [],
    })]);
    expect(ir.nodes.some((node) => node.entity_id === 'private-asset')).toBe(false);
    expect(ir.edges.some((edge) => edge.target.includes('private-asset'))).toBe(false);
  });

  it('distinguishes participation-only completeness and mode layers', () => {
    const partial = snapshot({
      activityRows: [],
      complete: { ...snapshot().complete, l0Activity: false },
      failedSources: ['task-activity/aggregate:partial'],
      fixedAssets: [{ agent_id: 'agt-1', asset_id: 'skill-1', asset_type: 'skill' }],
    });
    const actual = buildTeamAtlasIR('user-1', [partial], undefined, 'actual');
    const planned = buildTeamAtlasIR('user-1', [partial], undefined, 'planned');

    expect(actual.activities[0]).toMatchObject({
      evidence: 'participation_only', state: 'initialized_l0_unknown', counts_exact: false,
    });
    expect(actual.edges.some((edge) => edge.type === 'initialized_on')).toBe(true);
    expect(actual.edges.some((edge) => edge.type === 'planned_for' || edge.type === 'fixed_binding')).toBe(false);
    expect(actual.plans).toHaveLength(1);
    expect(actual.bindings).toEqual([
      expect.objectContaining({ team_id: 'team-1', agent_id: 'agt-1', asset_id: 'skill-1', asset_type: 'skill' }),
    ]);
    expect(planned.edges.some((edge) => edge.type === 'planned_for')).toBe(true);
    expect(planned.edges.some((edge) => edge.type === 'fixed_binding')).toBe(true);
    expect(planned.edges.some((edge) => edge.type === 'initialized_on')).toBe(false);
  });

  it('creates missing identity, agent, and logical chat memory placeholders for retained L0', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      participationLogs: [],
      activityRows: [{
        team_id: 'team-1', task_id: 'task-1', user_id: 'deleted-user', agent_id: 'deleted-agent',
        session_count: 1, l0_message_count: 1,
      }],
    })]);
    expect(ir.nodes).toContainEqual(expect.objectContaining({
      id: 'identity:team-1:deleted-user', status: 'missing', metadata: expect.objectContaining({ missing: true }),
    }));
    expect(ir.nodes).toContainEqual(expect.objectContaining({
      id: 'agent:deleted-agent', status: 'missing', metadata: expect.objectContaining({ missing: true }),
    }));
    expect(ir.nodes).toContainEqual(expect.objectContaining({
      id: 'chat_memory:chat_memory-team-1-deleted-agent',
      metadata: expect.objectContaining({ registered: null, can_read: false }),
    }));
  });

  it('deduplicates observed participants and warns about unassigned runtime agents', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      agents: [
        { agent_id: 'agt-1', team_id: 'team-1', owner_user_id: 'user-1', name: 'Codex', status: 'active' },
        { agent_id: 'agt-2', team_id: 'team-1', owner_user_id: 'user-1', name: 'Reviewer', status: 'active' },
      ],
      participationLogs: [
        { task_id: 'task-1', agent_id: 'agt-1', user_id: 'user-1', created_at: '2026-08-28T01:00:00.000Z' },
        { task_id: 'task-1', agent_id: 'agt-1', user_id: 'user-1', created_at: '2026-08-28T02:00:00.000Z' },
        { task_id: 'task-1', agent_id: 'agt-2', user_id: 'user-1', created_at: '2026-08-28T03:00:00.000Z' },
      ],
    })]);
    expect(ir.activities).toHaveLength(2);
    expect(ir.activities.find((activity) => activity.agent_id === 'agt-2')).toMatchObject({
      evidence: 'participation_only', state: 'initialized_no_dialogue', participation_event_count: 1,
    });
    expect(ir.edges.filter((edge) => edge.type === 'initialized_by')).toHaveLength(1);
    expect(ir.edges.filter((edge) => edge.type === 'initialized_on')).toHaveLength(1);
    expect(ir.warnings.filter((warning) => warning.code === 'TASK_PARTICIPATION_UNASSIGNED_AGENT')).toHaveLength(1);
  });

  it('keeps shared activity metrics canonical instead of copying the first Task onto shared edges', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      tasks: [
        { task_id: 'task-1', team_id: 'team-1', title: 'One', status: 'active', creator_user_id: 'user-1' },
        { task_id: 'task-2', team_id: 'team-1', title: 'Two', status: 'active', creator_user_id: 'user-1' },
      ],
      taskAgents: [
        { task_id: 'task-1', agent_id: 'agt-1', status: 'active' },
        { task_id: 'task-2', agent_id: 'agt-1', status: 'active' },
      ],
      participationLogs: [],
      activityRows: [
        { team_id: 'team-1', task_id: 'task-1', user_id: 'user-1', agent_id: 'agt-1', session_count: 1, l0_message_count: 2 },
        { team_id: 'team-1', task_id: 'task-2', user_id: 'user-1', agent_id: 'agt-1', session_count: 3, l0_message_count: 7 },
      ],
      activityVisibility: { 'task-1': 'full', 'task-2': 'full' },
    })], undefined, 'actual');
    const shared = ir.edges.find((edge) => edge.type === 'used_in_session');
    expect(shared?.metadata).toEqual({
      relation_kind: 'observed',
      task_ids: ['task-1', 'task-2'],
      activity_ids: [
        'activity:team-1:task-1:user-1:agt-1',
        'activity:team-1:task-2:user-1:agt-1',
      ],
    });
    expect(ir.activities.map((activity) => activity.l0_message_count)).toEqual([2, 7]);
  });

  it('builds 20k activity tuples without quadratic edge or lookup scans', () => {
    const tasks = Array.from({ length: 500 }, (_, index) => ({
      task_id: `task-${index}`, team_id: 'team-1', title: `Task ${index}`,
      status: 'active', creator_user_id: 'user-0',
    }));
    const members = Array.from({ length: 40 }, (_, index) => ({
      user_id: `user-${index}`, username: `User ${index}`,
      role: index === 0 ? 'admin' : 'member', status: 'active',
    }));
    const agents = Array.from({ length: 40 }, (_, index) => ({
      agent_id: `agent-${index}`, team_id: 'team-1', owner_user_id: `user-${index}`,
      name: `Agent ${index}`, status: 'active',
    }));
    const activityRows = tasks.flatMap((task) => agents.map((agent, index) => ({
      team_id: 'team-1', task_id: task.task_id, user_id: `user-${index}`,
      agent_id: agent.agent_id, session_count: 1, l0_message_count: 1,
    })));
    const startedAt = performance.now();
    const ir = buildTeamAtlasIR('user-0', [snapshot({
      members, tasks, agents, assets: [], taskAgents: [], participationLogs: [],
      fixedAssets: [], skills: [], activityRows,
      activityVisibility: Object.fromEntries(tasks.map((task) => [task.task_id, 'full'])) as Record<string, 'full'>,
      complete: { ...snapshot().complete, taskAgents: false },
      failedSources: ['task-agent/list:partial'],
    })], '2026-08-31T00:00:00.000Z', 'actual');
    const elapsedMs = performance.now() - startedAt;

    expect(ir.activities).toHaveLength(20_000);
    expect(ir.edges.filter((edge) => edge.type === 'used_in_session')).toHaveLength(40);
    expect(ir.edges.filter((edge) => edge.type === 'records_to')).toHaveLength(40);
    expect(ir.edges.filter((edge) => edge.type === 'contains_task_l0')).toHaveLength(20_000);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 10_000);
});

describe('task activity permissions', () => {
  const team = { team_id: 'team-1', name: 'Atlas', owner_user_id: 'owner' };
  const tasks = [
    { task_id: 'mine', team_id: 'team-1', title: 'Mine', creator_user_id: 'member' },
    { task_id: 'other', team_id: 'team-1', title: 'Other', creator_user_id: 'owner' },
  ];

  it('allows owner and admin to see full team activity', () => {
    expect(resolveTaskActivityVisibility('owner', team, 'admin', tasks)).toEqual({ mine: 'full', other: 'full' });
    expect(resolveTaskActivityVisibility('reviewer', team, 'admin', tasks)).toEqual({ mine: 'full', other: 'full' });
  });

  it('allows a task creator full activity only on their task', () => {
    expect(resolveTaskActivityVisibility('member', team, 'member', tasks)).toEqual({ mine: 'full', other: 'self_only' });
  });
});

describe('mapInBatches', () => {
  it('starts at most twenty agent requests before awaiting the next batch', async () => {
    let active = 0;
    let peak = 0;
    const mapper = vi.fn(async (value: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value;
    });
    const result = await mapInBatches(Array.from({ length: 41 }, (_, index) => index), 20, mapper);
    expect(result).toHaveLength(41);
    expect(peak).toBe(20);
  });
});

describe('fetchFanoutBounded', () => {
  it('shares one hard cap across all fan-out inputs', async () => {
    const remaining: number[] = [];
    const result = await fetchFanoutBounded([400, 400], async (count, budget) => {
      remaining.push(budget);
      const items = Array.from({ length: Math.min(count, budget) }, (_, index) => index);
      return { items, complete: count <= budget };
    }, 500);
    expect(remaining).toEqual([250, 250]);
    expect(remaining.reduce((sum, budget) => sum + budget, 0)).toBe(500);
    expect(result.items).toHaveLength(500);
    expect(result.complete).toBe(false);
  });

  it('reuses sparse reservations to fully page one dense input below the global cap', async () => {
    const counts = [400, ...Array.from({ length: 19 }, () => 0)];
    const calls: Array<{ input: number; budget: number; offset: number }> = [];
    const result = await fetchFanoutBounded(counts, async (count, budget, offset) => {
      calls.push({ input: count, budget, offset });
      const size = Math.min(budget, Math.max(0, count - offset));
      return {
        items: Array.from({ length: size }, (_, index) => offset + index),
        complete: offset + size >= count,
      };
    }, 500);
    expect(result.items).toHaveLength(400);
    expect(result.complete).toBe(true);
    expect(result.hadFailure).toBe(false);
    expect(calls.filter((call) => call.input === 400)).toEqual([
      { input: 400, budget: 25, offset: 0 },
      { input: 400, budget: 475, offset: 25 },
    ]);
    expect(new Set(result.items).size).toBe(400);
  });

  it('uses bounded concurrency for empty fan-out sources', async () => {
    let active = 0;
    let peak = 0;
    const result = await fetchFanoutBounded(
      Array.from({ length: 41 }, (_, index) => index),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { items: [], complete: true };
      },
    );
    expect(result).toEqual({ items: [], complete: true, hadFailure: false });
    expect(peak).toBe(20);
  });

  it('retains confirmed later results when one fan-out request fails', async () => {
    const result = await fetchFanoutBounded(['failed', 'ok'], async (value) => {
      if (value === 'failed') throw new Error('unavailable');
      return { items: [value], complete: true };
    });
    expect(result).toEqual({ items: ['ok'], complete: false, hadFailure: true });
  });
});
