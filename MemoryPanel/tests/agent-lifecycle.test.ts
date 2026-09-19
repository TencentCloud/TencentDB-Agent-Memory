import { Hono } from 'hono';
import { describe, it, expect, vi } from 'vitest';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import { registerAgentLifecycleRoutes } from '../src/panel/http/routes/agent-lifecycle.js';

/** 成功信封。 */
function okEnv<T>(data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: 'req-test', data };
}

/** 失败信封（模拟内核 errorEnvelope，data 缺省）。 */
function errEnv(code: number, message: string): MetaEnvelope<undefined> {
  return { code, message, request_id: 'req-test', data: undefined };
}

/** 生成 n 条 active skill 行。 */
function makeSkills(n: number): Array<{ skill_id: string; version: number }> {
  return Array.from({ length: n }, (_, i) => ({ skill_id: `skill-${i + 1}`, version: 1 }));
}

interface SkillListBody {
  pagination?: { limit?: number; offset?: number };
}

/** 组装被测路由所需的最小 deps fixture（auth/config 等整块省略，见 app.ts 注释）。 */
function buildDeps() {
  const metaInvoke = vi.fn();
  const skillInvoke = vi.fn();
  const deps = {
    instanceRegistry: {
      resolve: (instanceId: string) => ({
        instance_id: instanceId,
        gateway_endpoint: 'http://gateway.test',
        api_key: 'test-api-key',
      }),
    },
    metaKernel: { invoke: metaInvoke },
    skillKernel: { invoke: skillInvoke },
  } as unknown as PanelDeps;
  return { deps, metaInvoke, skillInvoke };
}

/** 标准 meta 桩：auth/verify → user-1；agent/get → owner=user-1；agent/archive → ok。 */
function setupMeta(metaInvoke: ReturnType<typeof vi.fn>) {
  metaInvoke.mockImplementation(async (action: string) => {
    if (action === 'auth/verify') {
      return okEnv({ valid: true, user: { user_id: 'user-1' } });
    }
    if (action === 'agent/get') {
      return okEnv({ agent_id: 'agent-1', team_id: 'team-1', owner_user_id: 'user-1' });
    }
    if (action === 'agent/archive') {
      return okEnv({ archived: true });
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
}

const HEADERS = {
  'content-type': 'application/json',
  'x-tdai-service-id': 'inst-1',
  'x-tdai-user-key': 'user-key-1',
};

async function deleteAgent(app: Hono, agentId: string): Promise<Response> {
  return app.request('/agent/delete-cascade', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ agent_id: agentId }),
  });
}

describe('agent/delete-cascade', () => {
  it('archives agent when SkillCore is disabled from the start (nothing to cascade)', async () => {
    const { deps, metaInvoke, skillInvoke } = buildDeps();
    setupMeta(metaInvoke);
    skillInvoke.mockImplementation(async (action: string) => {
      if (action === 'list') return errEnv(404, 'Skill module not enabled');
      throw new Error(`unexpected skill action: ${action}`);
    });

    const app = new Hono();
    registerAgentLifecycleRoutes(app, deps);

    const res = await deleteAgent(app, 'agent-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      archived: true,
      agent_id: 'agent-1',
      deleted_skill_count: 0,
      deleted_skill_ids: [],
    });
    // 未启用时不应尝试删任何 skill，但仍要 archive agent
    expect(skillInvoke.mock.calls.every(([action]) => action === 'list')).toBe(true);
    expect(metaInvoke).toHaveBeenCalledWith('agent/archive', expect.anything(), expect.anything());
  });

  it('fails closed when pagination already started and page 2 reports SkillCore disabled', async () => {
    const { deps, metaInvoke, skillInvoke } = buildDeps();
    setupMeta(metaInvoke);
    const page1 = makeSkills(100);
    skillInvoke.mockImplementation(async (action: string, body: SkillListBody) => {
      if (action !== 'list') throw new Error(`unexpected skill action: ${action}`);
      if ((body.pagination?.offset ?? 0) === 0) {
        // 第 1 页：100 条 + total=101，说明还有第 2 页
        return okEnv({ items: page1, total: 101 });
      }
      // 第 2 页（offset=100）：内核 SkillCore 被禁用
      return errEnv(404, 'Skill module not enabled');
    });

    const app = new Hono();
    registerAgentLifecycleRoutes(app, deps);

    const res = await deleteAgent(app, 'agent-1');
    const body = await res.json();

    // 已观察到的 100 个 skill 不能被静默漏删 → 必须 fail-closed 透传错误
    expect(res.status).toBe(404);
    expect(body.code).toBe(404);
    expect(body.message).toBe('Skill module not enabled');
    expect(metaInvoke).not.toHaveBeenCalledWith('agent/archive', expect.anything(), expect.anything());
    expect(skillInvoke).not.toHaveBeenCalledWith('delete', expect.anything(), expect.anything());
  });

  it('cascades skills across pages then archives', async () => {
    const { deps, metaInvoke, skillInvoke } = buildDeps();
    setupMeta(metaInvoke);
    const page1 = makeSkills(100);
    const page2 = [{ skill_id: 'skill-101', version: 1 }];
    skillInvoke.mockImplementation(async (action: string, body: SkillListBody) => {
      if (action === 'list') {
        const offset = body.pagination?.offset ?? 0;
        return offset === 0
          ? okEnv({ items: page1, total: 101 })
          : okEnv({ items: page2, total: 101 });
      }
      if (action === 'delete') return okEnv({});
      throw new Error(`unexpected skill action: ${action}`);
    });

    const app = new Hono();
    registerAgentLifecycleRoutes(app, deps);

    const res = await deleteAgent(app, 'agent-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.deleted_skill_count).toBe(101);
    expect(body.data.deleted_skill_ids).toHaveLength(101);
    expect(skillInvoke.mock.calls.filter(([action]) => action === 'delete')).toHaveLength(101);
    expect(metaInvoke).toHaveBeenCalledWith('agent/archive', expect.anything(), expect.anything());
  });

  it('fails closed on a genuine skill list error (not the module-disabled signal)', async () => {
    const { deps, metaInvoke, skillInvoke } = buildDeps();
    setupMeta(metaInvoke);
    skillInvoke.mockImplementation(async (action: string) => {
      if (action === 'list') return errEnv(500, 'internal error');
      throw new Error(`unexpected skill action: ${action}`);
    });

    const app = new Hono();
    registerAgentLifecycleRoutes(app, deps);

    const res = await deleteAgent(app, 'agent-1');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe(500);
    expect(metaInvoke).not.toHaveBeenCalledWith('agent/archive', expect.anything(), expect.anything());
  });
});
