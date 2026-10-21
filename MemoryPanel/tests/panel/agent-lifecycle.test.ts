/**
 * /api/v1/agent/delete-cascade 路由级回归（issue #1218）。
 *
 * 内核用 stub 模拟（不拉真实 MemoryCore），只验证 control 层的错误分类与调用
 * 顺序：
 *   1. SkillCore 明确未启用 → 空 agent 仍可归档
 *   2. skill/list 返回其它 404 → 保持 fail-closed
 *   3. skill/list 返回其它错误 → 保持 fail-closed
 *   4. 有 skill 时先逐条删除、再归档（顺序）
 *   5. skill/delete 失败 → 不归档
 *   6. 分页边界：分页已跑起来后才报「能力缺失」→ 不允许按空集合放行
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerAgentLifecycleRoutes } from '../../src/panel/http/routes/agent-lifecycle.js';

const INSTANCE_ID = 'inst-1';
const USER_KEY = 'sk-mem-test-key';
const CALLER_ID = 'user-1';
const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

/** 与 MemoryCore/src/gateway/skill-handlers.ts 吐出的「能力缺失」信封一致。 */
const SKILL_MODULE_NOT_ENABLED: MetaEnvelope<null> = {
  code: 404,
  message: 'Skill module not enabled',
  request_id: 'req-kernel',
  data: null,
};

function envelope<T>(code: number, message: string, data: T): MetaEnvelope<T> {
  return { code, message, request_id: 'req-test', data };
}

interface SkillRow {
  skill_id: string;
  version: number;
}

interface SkillListPage {
  items: SkillRow[];
  total: number;
}

interface Harness {
  app: Hono;
  /** 内核调用顺序日志，形如 "skill:list" / "skill:delete:sk-1" / "agent:archive"。 */
  calls: string[];
}

/**
 * 分页返回器：数组形式按页索引取；函数形式自己决定每一页（用于构造「第一页成功、
 * 第二页才报能力缺失」这类非法的上游行为）。
 */
type SkillListPages = SkillListPage[] | ((pageIndex: number) => MetaEnvelope<unknown>);

function buildHarness(opts: {
  skillListPages?: SkillListPages;
  skillDelete?: (body: Record<string, unknown>) => MetaEnvelope<unknown>;
} = {}): Harness {
  const calls: string[] = [];
  let listPageIndex = 0;
  const emptyPages: SkillListPages = [{ items: [], total: 0 }];
  const pages = opts.skillListPages ?? emptyPages;

  const nextListEnvelope = (): MetaEnvelope<unknown> => {
    const index = listPageIndex++;
    if (typeof pages === 'function') return pages(index);
    const page = pages[index] ?? { items: [], total: 0 };
    return envelope(0, 'ok', { items: page.items, total: page.total });
  };

  const metaKernel = {
    invoke: async (action: string, body: Record<string, unknown>): Promise<MetaEnvelope> => {
      if (action === 'auth/verify') {
        return envelope(0, 'ok', { valid: true, user: { user_id: CALLER_ID } });
      }
      if (action === 'agent/get') {
        return envelope(0, 'ok', {
          agent_id: String(body.agent_id ?? AGENT_ID),
          team_id: TEAM_ID,
          owner_user_id: CALLER_ID,
        });
      }
      if (action === 'agent/archive') {
        calls.push('agent:archive');
        return envelope(0, 'ok', { archived: true });
      }
      throw new Error(`unexpected meta action: ${action}`);
    },
  };

  const skillKernel = {
    invoke: async (action: string, body: Record<string, unknown>): Promise<MetaEnvelope> => {
      if (action === 'list') {
        calls.push('skill:list');
        return nextListEnvelope();
      }
      if (action === 'delete') {
        calls.push(`skill:delete:${String(body.skill_id)}`);
        return opts.skillDelete ? opts.skillDelete(body) : envelope(0, 'ok', { deleted: true });
      }
      throw new Error(`unexpected skill action: ${action}`);
    },
  };

  const deps = {
    instanceRegistry: {
      resolve: () => ({
        instance_id: INSTANCE_ID,
        gateway_endpoint: 'http://kernel.test',
        api_key: 'gw-key',
      }),
    },
    metaKernel,
    skillKernel,
  } as unknown as PanelDeps;

  const app = new Hono();
  registerAgentLifecycleRoutes(app, deps);
  return { app, calls };
}

async function deleteCascade(app: Hono, agentId: string = AGENT_ID): Promise<Response> {
  return app.request('/agent/delete-cascade', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': INSTANCE_ID,
      'x-tdai-user-key': USER_KEY,
    },
    body: JSON.stringify({ agent_id: agentId }),
  });
}

describe('POST /agent/delete-cascade', () => {
  it('archives an agent with no skills when SkillCore is disabled', async () => {
    const { app, calls } = buildHarness({
      skillListPages: () => SKILL_MODULE_NOT_ENABLED,
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    expect(body.data.archived).toBe(true);
    expect(body.data.deleted_skill_count).toBe(0);
    expect(calls).toEqual(['skill:list', 'agent:archive']);
  });

  it('stays fail-closed for an unrelated skill/list 404', async () => {
    const { app, calls } = buildHarness({
      skillListPages: () => envelope(404, 'agent not found', null),
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(404);
    expect(calls).toEqual(['skill:list']);
    expect(calls).not.toContain('agent:archive');
  });

  it('stays fail-closed for other skill/list errors', async () => {
    const { app, calls } = buildHarness({
      skillListPages: () => envelope(500, 'kernel exploded', null),
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(500);
    expect(calls).toEqual(['skill:list']);
    expect(calls).not.toContain('agent:archive');
  });

  it('deletes existing skills before archiving the agent', async () => {
    const { app, calls } = buildHarness({
      skillListPages: [
        {
          items: [
            { skill_id: 'sk-1', version: 1 },
            { skill_id: 'sk-2', version: 3 },
          ],
          total: 2,
        },
      ],
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.deleted_skill_ids).toEqual(['sk-1', 'sk-2']);
    expect(calls).toEqual([
      'skill:list',
      'skill:delete:sk-1',
      'skill:delete:sk-2',
      'agent:archive',
    ]);
  });

  it('does not archive the agent when a skill/delete fails', async () => {
    const { app, calls } = buildHarness({
      skillListPages: [{ items: [{ skill_id: 'sk-1', version: 1 }], total: 1 }],
      skillDelete: () => envelope(500, 'skill delete rejected', null),
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string; data: Record<string, unknown> };
    expect(body.message).toBe('SKILL_DELETE_FAILED');
    expect(body.data.failed_skill_id).toBe('sk-1');
    expect(calls).toEqual(['skill:list', 'skill:delete:sk-1']);
    expect(calls).not.toContain('agent:archive');
  });

  it('refuses to treat a mid-pagination capability miss as "no skills"', async () => {
    const firstPage: SkillRow[] = Array.from({ length: 100 }, (_, i) => ({
      skill_id: `sk-${i}`,
      version: 1,
    }));
    const { app, calls } = buildHarness({
      // 上游自相矛盾：先给了 100 条 / total=101，下一页才报「SkillCore 未启用」。
      // 放行会把已观测到的 100 个 skill 当成不存在直接归档 → 留下 orphan。
      skillListPages: (pageIndex: number) =>
        pageIndex === 0
          ? envelope(0, 'ok', { items: firstPage, total: 101 })
          : SKILL_MODULE_NOT_ENABLED,
    });

    const res = await deleteCascade(app);

    expect(res.status).toBe(404);
    expect(calls).toEqual(['skill:list', 'skill:list']);
    expect(calls).not.toContain('agent:archive');
  });
});
