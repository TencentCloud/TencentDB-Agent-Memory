import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerTeamAtlasRoutes } from '../src/panel/http/routes/team-atlas.js';

type FixtureOptions = {
  activityRowCount?: number;
  memberCount?: number;
  includeTask?: boolean;
  failCodeGraph?: boolean;
  includeWiki?: boolean;
};

function page<T>(items: T[], body: Record<string, unknown>) {
  const offset = typeof body.offset === 'number' ? body.offset : 0;
  const limit = typeof body.limit === 'number' ? body.limit : 100;
  return {
    code: 0,
    message: 'ok',
    request_id: 'r',
    data: { items: items.slice(offset, offset + limit), total: items.length },
  };
}

function createApp(options: FixtureOptions = {}) {
  const includeTask = options.includeTask === true;
  const members = Array.from({ length: options.memberCount ?? 1 }, (_, index) => ({
    user_id: index === 0 ? 'member-user' : `other-member-${index}`,
    username: index === 0 ? 'Member' : `Other ${index}`,
    role: 'member',
    status: 'active',
  }));
  const tasks = includeTask
    ? [{ task_id: 'task-1', team_id: 'team-1', title: 'Private activity', status: 'active', creator_user_id: 'owner-user' }]
    : [];
  const agents = includeTask
    ? [{ agent_id: 'agent-1', team_id: 'team-1', owner_user_id: 'member-user', name: 'Agent', status: 'active' }]
    : [];
  const participation = includeTask
    ? [
        { task_id: 'task-1', agent_id: 'agent-1', user_id: 'member-user', created_at: '2026-08-31T01:00:00.000Z' },
        { task_id: 'task-1', agent_id: 'agent-1', user_id: 'other-user', created_at: '2026-08-31T02:00:00.000Z' },
      ]
    : [];
  const metaInvoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
    if (action === 'auth/verify') {
      return { code: 0, message: 'ok', request_id: 'r', data: { valid: true, user: { user_id: 'member-user' } } };
    }
    if (action === 'team/list') {
      return page([{ team_id: 'team-1', name: 'Atlas', owner_user_id: 'owner-user', status: 'active' }], body);
    }
    if (action === 'team-member/list') return page(members, body);
    if (action === 'task/list') return page(tasks, body);
    if (action === 'agent/list') return page(agents, body);
    if (action === 'participation-log/list') return page(participation, body);
    if (action === 'task-agent/list') {
      return page(includeTask ? [{ task_id: 'task-1', agent_id: 'agent-1', status: 'active' }] : [], body);
    }
    if (action === 'asset/list-accessible') {
      if (body.asset_type === 'code_graph' && options.failCodeGraph) throw new Error('code graph source unavailable');
      if (body.asset_type === 'llm_wiki' && options.includeWiki) {
        return page([{ asset_id: 'wiki-1', team_id: 'team-1', asset_type: 'llm_wiki', name: 'Confirmed Wiki', owner_user_id: 'member-user', status: 'active' }], body);
      }
      return page([], body);
    }
    if (action === 'agent-fixed-asset/list') {
      return page([], body);
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
  const postEnvelope = vi.fn(async (path: string, body: Record<string, unknown>) => {
    if (path !== '/v3/topology/task-activity/aggregate') throw new Error(`unexpected ${path}`);
    const activityItems = options.activityRowCount
      ? Array.from({ length: options.activityRowCount }, (_, index) => ({
          team_id: 'team-1', task_id: 'task-1', user_id: 'member-user',
          agent_id: `agent-${index}`, session_count: 1, l0_message_count: 1,
        }))
      : [{
          team_id: 'team-1', task_id: 'task-1', user_id: 'member-user', agent_id: 'agent-1',
          session_count: 1, l0_message_count: 2,
        }, {
          team_id: 'team-1', task_id: 'task-1', user_id: 'other-user', agent_id: 'agent-1',
          session_count: 999, l0_message_count: 999, last_seen_at: 'other-user-private-time',
        }];
    return {
      code: 0,
      message: 'ok',
      request_id: 'r',
      data: {
        items: activityItems,
        completeness: 'complete',
        truncated: false,
      },
    };
  });
  const deps = {
    instanceRegistry: { resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'secret' }) },
    config: { metadataRemoteTimeoutMs: 15_000 },
    metaKernel: { invoke: metaInvoke },
    skillKernel: { invoke: vi.fn(async () => ({ code: 0, data: { items: [], total: 0 } })) },
    kernelHttp: { postEnvelope },
  } as never;
  const app = new Hono();
  registerTeamAtlasRoutes(app, deps);
  return { app, postEnvelope };
}

function bootstrap(app: Hono, body: Record<string, unknown>) {
  return app.request('/topology/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Tdai-Service-Id': 'local',
      'X-Tdai-User-Key': 'user-key',
    },
    body: JSON.stringify(body),
  });
}

describe('team atlas bootstrap route', () => {
  it('requires one to four explicitly selected Teams', async () => {
    const { app } = createApp();
    expect((await bootstrap(app, {})).status).toBe(400);
    expect((await bootstrap(app, { team_ids: ['1', '2', '3', '4', '5'] })).status).toBe(400);
  });

  it('keeps self-only activity scoped at the HTTP response boundary', async () => {
    const { app, postEnvelope } = createApp({ includeTask: true });
    const response = await bootstrap(app, { team_ids: ['team-1'], mode: 'actual' });
    const envelope = await response.json() as { data: { activities: Array<{ user_id: string; l0_message_count: number }> } };
    expect(response.status).toBe(200);
    expect(envelope.data.activities.map((activity) => activity.user_id)).toEqual(['member-user']);
    expect(JSON.stringify(envelope)).not.toContain('other-user');
    expect(JSON.stringify(envelope)).not.toContain('other-user-private-time');
    expect(envelope.data.activities).toEqual([
      expect.objectContaining({ user_id: 'member-user', l0_message_count: 2 }),
    ]);
    expect(JSON.stringify(envelope)).not.toContain('message_text');
    expect(postEnvelope).toHaveBeenCalledWith(
      '/v3/topology/task-activity/aggregate',
      expect.objectContaining({ team_id: 'team-1', task_ids: ['task-1'], user_id: 'member-user' }),
      expect.anything(),
    );
  });

  it('preserves successful asset types when another asset source fails', async () => {
    const { app } = createApp({ failCodeGraph: true, includeWiki: true });
    const response = await bootstrap(app, { team_ids: ['team-1'], mode: 'planned' });
    const envelope = await response.json() as {
      data: { completeness: string; nodes: Array<{ id: string }>; warnings: Array<{ source?: string }> };
    };
    expect(response.status).toBe(200);
    expect(envelope.data.completeness).toBe('partial');
    expect(envelope.data.nodes).toContainEqual(expect.objectContaining({ id: 'llm_wiki:wiki-1' }));
    expect(envelope.data.warnings).toContainEqual(
      expect.objectContaining({ source: 'asset/list-accessible:code_graph' }),
    );
  });

  it('marks capped sources partial instead of inferring a complete graph', async () => {
    const { app } = createApp({ memberCount: 501 });
    const response = await bootstrap(app, { team_ids: ['team-1'], mode: 'all' });
    const envelope = await response.json() as {
      data: { completeness: string; warnings: Array<{ source?: string }> };
    };
    expect(response.status).toBe(200);
    expect(envelope.data.completeness).toBe('partial');
    expect(envelope.data.warnings).toContainEqual(
      expect.objectContaining({ source: 'team-member/list:truncated' }),
    );
  });

  it('caps L0 activity facts at 500 and marks every retained count as a lower bound', async () => {
    const { app } = createApp({ includeTask: true, activityRowCount: 501 });
    const response = await bootstrap(app, { team_ids: ['team-1'], mode: 'actual' });
    const envelope = await response.json() as {
      data: {
        completeness: string;
        activities: Array<{ counts_exact: boolean }>;
        warnings: Array<{ source?: string }>;
      };
    };
    expect(response.status).toBe(200);
    expect(envelope.data.completeness).toBe('partial');
    expect(envelope.data.activities).toHaveLength(500);
    expect(envelope.data.activities.every((activity) => !activity.counts_exact)).toBe(true);
    expect(envelope.data.warnings).toContainEqual(
      expect.objectContaining({ source: 'task-activity/aggregate:partial' }),
    );
  });
});
