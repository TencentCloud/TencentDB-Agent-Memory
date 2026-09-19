/**
 * /api/v1/agent/delete-cascade 路由级回归测试（issue #1218）。
 *
 * 背景：该路由在归档 agent 前会先拉 skill/list 并逐个 skill/delete。当 MemoryCore
 * 未启用 SkillCore 时，skill/list 会返回「能力缺失」信封（404 +
 * "Skill module not enabled"），修复前该响应被原样透传，导致即便是**没有任何 skill**
 * 的 agent 也无法删除（永远走不到 meta/agent/archive）。
 *
 * 覆盖五组行为：
 *   1. 能力缺失（首页命中）→ 视为空 skill 集合，继续 archive（不调 skill/delete）；
 *   2. fail-closed → 其它 404 / list 错误一律原样透传，绝不 archive；
 *   3. 分页边界 → 分页中途才回能力缺失属自相矛盾响应，同样 fail-closed；
 *   4. 正常路径 → skill 全部删除成功后才 archive，顺序与删除清单正确；
 *   5. delete 失败 → 中断且不 archive，错误里带失败 skill_id 与已删清单。
 *
 * 测试方式：不启 HTTP server，直接把路由挂到独立 Hono app 上，用最小 fake deps
 * （meta/skill 两个 kernel port）驱动，并用 timeline 断言内核调用的**先后顺序**——
 * 「先删 skill 再 archive」是这条路由的核心不变量，只看返回值不足以证明。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import { registerAgentLifecycleRoutes } from '../../src/panel/http/routes/agent-lifecycle.js';

const INSTANCE_ID = 'inst-test';
const USER_KEY = 'uk-test';
const CALLER_ID = 'user-caller';
const AGENT_ID = 'agent-1';
const TEAM_ID = 'team-1';

/** 与 MemoryCore/src/gateway/skill-handlers.ts 的 errorEnvelope(404, ...) 完全一致。 */
const SKILL_MODULE_DISABLED_CODE = 404;
const SKILL_MODULE_DISABLED_MESSAGE = 'Skill module not enabled';

interface SkillRow {
  skill_id: string;
  version: number;
}

interface DeleteCascadeData {
  archived: boolean;
  agent_id: string;
  deleted_skill_count: number;
  deleted_skill_ids: string[];
}

interface DeleteFailureData {
  failed_skill_id: string;
  kernel_code: number;
  kernel_message: string;
  deleted_skill_ids: string[];
}

function envelope<T>(code: number, message: string, data: T): MetaEnvelope<T> {
  return { code, message, request_id: 'req-test', data };
}

function silentLogger(): PanelDeps['logger'] {
  const logger: PanelDeps['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

interface HarnessOptions {
  /** skill/list 响应；默认返回空集合。index 从 0 递增，offset 为本次分页偏移。 */
  list?: (call: { index: number; offset: number }) => MetaEnvelope<unknown>;
  /** skill/delete 响应；默认成功。 */
  delete?: (skillId: string) => MetaEnvelope<unknown>;
  /** agent/archive 响应；默认成功。 */
  archive?: () => MetaEnvelope<unknown>;
  /** agent/get 响应；默认返回一个归属 CALLER_ID 的 active agent。 */
  agent?: () => MetaEnvelope<unknown>;
}

interface Harness {
  app: Hono;
  /** 内核调用时序（如 'skill:delete:skill-1'），用于断言 delete 全在 archive 之前。 */
  timeline: string[];
  listOffsets: number[];
  /** 实际发起过 delete 的 skill_id（含失败的那一条）。 */
  requestedDeleteIds: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const timeline: string[] = [];
  const listOffsets: number[] = [];
  const requestedDeleteIds: string[] = [];

  const metaKernel = {
    async invoke(action: string): Promise<MetaEnvelope<unknown>> {
      timeline.push(`meta:${action}`);
      if (action === 'auth/verify') {
        return envelope(0, 'ok', { valid: true, user: { user_id: CALLER_ID } });
      }
      if (action === 'agent/get') {
        return (
          options.agent?.() ??
          envelope(0, 'ok', {
            agent_id: AGENT_ID,
            team_id: TEAM_ID,
            owner_user_id: CALLER_ID,
            status: 'active',
          })
        );
      }
      if (action === 'agent/archive') {
        return options.archive?.() ?? envelope(0, 'ok', { archived: true });
      }
      throw new Error(`unexpected meta action: ${action}`);
    },
  };

  const skillKernel = {
    async invoke(action: string, body: Record<string, unknown>): Promise<MetaEnvelope<unknown>> {
      if (action === 'list') {
        const offset = (body.pagination as { offset: number }).offset;
        timeline.push(`skill:list@${offset}`);
        listOffsets.push(offset);
        return (
          options.list?.({ index: listOffsets.length - 1, offset }) ??
          envelope(0, 'ok', { items: [], total: 0 })
        );
      }
      if (action === 'delete') {
        const skillId = body.skill_id as string;
        timeline.push(`skill:delete:${skillId}`);
        requestedDeleteIds.push(skillId);
        return options.delete?.(skillId) ?? envelope(0, 'ok', {});
      }
      throw new Error(`unexpected skill action: ${action}`);
    },
  };

  const deps = {
    config: { auth: { sessionCookieName: 'panel_session' }, metadataRemoteTimeoutMs: 30_000 },
    logger: silentLogger(),
    instanceRegistry: {
      resolve: () => ({
        instance_id: INSTANCE_ID,
        name: 'test-instance',
        gateway_endpoint: 'http://kernel.invalid',
        api_key: 'test-api-key',
      }),
    },
    metaKernel,
    skillKernel,
    auth: { resolveSession: () => null },
  } as unknown as PanelDeps;

  const api = new Hono();
  api.use('*', async (c, next) => {
    c.set('reqId', c.req.header('x-request-id') ?? 'req-test');
    await next();
  });
  registerAgentLifecycleRoutes(api, deps);

  const app = new Hono();
  app.route('/api/v1', api);
  return { app, timeline, listOffsets, requestedDeleteIds };
}

async function deleteCascade(
  harness: Harness,
  body: Record<string, unknown> = { agent_id: AGENT_ID },
): Promise<{ status: number; body: MetaEnvelope<unknown> }> {
  const res = await harness.app.request('/api/v1/agent/delete-cascade', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': INSTANCE_ID,
      'x-tdai-user-key': USER_KEY,
      'x-request-id': 'req-test',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as MetaEnvelope<unknown> };
}

describe('delete-cascade · SkillCore 未启用（issue #1218 回归）', () => {
  it('把 404 "Skill module not enabled" 当作空 skill 集合，继续归档无 skill 的 agent', async () => {
    const harness = createHarness({
      list: () => envelope(SKILL_MODULE_DISABLED_CODE, SKILL_MODULE_DISABLED_MESSAGE, null),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as DeleteCascadeData;

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(data.archived).toBe(true);
    expect(data.agent_id).toBe(AGENT_ID);
    expect(data.deleted_skill_count).toBe(0);
    expect(data.deleted_skill_ids).toEqual([]);

    // 关键不变量：没有 skill 可删 → 直接 archive，且顺序正确。
    expect(harness.requestedDeleteIds).toEqual([]);
    expect(harness.timeline).toEqual([
      'meta:auth/verify',
      'meta:agent/get',
      'skill:list@0',
      'meta:agent/archive',
    ]);
  });

  it('能力缺失文案前后带空白同样判定为能力缺失', async () => {
    const harness = createHarness({
      list: () => envelope(SKILL_MODULE_DISABLED_CODE, `  ${SKILL_MODULE_DISABLED_MESSAGE}  `, null),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(200);
    expect((body.data as DeleteCascadeData).archived).toBe(true);
    expect(harness.timeline).toContain('meta:agent/archive');
  });

  it('分页已开始后才回能力缺失 → 视为自相矛盾响应，保持 fail-closed', async () => {
    // 场景来自同仓 #1219 评审中指出的分页边界：能力缺失是**模块级**属性，不可能
    // 第一页正常返回 100 条、翻到第二页才说模块未启用。若按空集合继续归档，第 101
    // 条 skill 既不会被列出也不会被删除，会变成孤儿 active skill —— 恰好违背本路由
    // 的存在意义。因此这里必须原样透传错误，不删任何 skill、不 archive。
    const firstPage: SkillRow[] = Array.from({ length: 100 }, (_, i) => ({
      skill_id: `skill-${i + 1}`,
      version: 1,
    }));
    const harness = createHarness({
      list: ({ index }) =>
        index === 0
          ? envelope(0, 'ok', { items: firstPage, total: firstPage.length + 1 })
          : envelope(SKILL_MODULE_DISABLED_CODE, SKILL_MODULE_DISABLED_MESSAGE, null),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.code).toBe(SKILL_MODULE_DISABLED_CODE);
    expect(body.message).toBe(SKILL_MODULE_DISABLED_MESSAGE);
    expect(harness.listOffsets).toEqual([0, 100]);
    expect(harness.requestedDeleteIds).toEqual([]);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });
});

describe('delete-cascade · fail-closed：不吞无关 list 失败', () => {
  it('同为 404 但 message 不是能力缺失 → 原样透传，不 archive', async () => {
    const harness = createHarness({ list: () => envelope(404, 'Skill not found', null) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.code).toBe(404);
    expect(body.message).toBe('Skill not found');
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('message 只是包含能力缺失文案（非全等）→ 不放行，不 archive', async () => {
    const harness = createHarness({
      list: () => envelope(404, 'Skill module not enabled for team', null),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.message).toBe('Skill module not enabled for team');
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('SkillCore 可用时的 list 失败（500）→ 原样透传，不 archive', async () => {
    const harness = createHarness({ list: () => envelope(500, 'SKILL_LIST_FAILED', null) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(500);
    expect(body.message).toBe('SKILL_LIST_FAILED');
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });
});

describe('delete-cascade · 正常路径：先删 skill 再 archive', () => {
  it('逐个删除 skill 成功后才 archive，返回完整删除清单', async () => {
    const skills: SkillRow[] = [
      { skill_id: 'skill-1', version: 3 },
      { skill_id: 'skill-2', version: 1 },
    ];
    const harness = createHarness({
      list: ({ index }) =>
        index === 0
          ? envelope(0, 'ok', { items: skills, total: skills.length })
          : envelope(0, 'ok', { items: [], total: skills.length }),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as DeleteCascadeData;

    expect(status).toBe(200);
    expect(data.archived).toBe(true);
    expect(data.deleted_skill_count).toBe(2);
    expect(data.deleted_skill_ids).toEqual(['skill-1', 'skill-2']);

    expect(harness.timeline).toEqual([
      'meta:auth/verify',
      'meta:agent/get',
      'skill:list@0',
      'skill:delete:skill-1',
      'skill:delete:skill-2',
      'meta:agent/archive',
    ]);
  });

  it('skill 多于单页时按 100 步长拉全，再依次删除', async () => {
    const harness = createHarness({
      list: ({ index }) =>
        index === 0
          ? envelope(0, 'ok', { items: [{ skill_id: 'skill-1', version: 1 }], total: 2 })
          : envelope(0, 'ok', { items: [{ skill_id: 'skill-2', version: 1 }], total: 2 }),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(200);
    expect(harness.listOffsets).toEqual([0, 100]);
    expect(harness.requestedDeleteIds).toEqual(['skill-1', 'skill-2']);
    expect((body.data as DeleteCascadeData).deleted_skill_ids).toEqual(['skill-1', 'skill-2']);
  });
});

describe('delete-cascade · skill/delete 失败仍然 fail-closed', () => {
  it('中途删除失败 → 500 + 失败 skill_id + 已删清单，且不 archive', async () => {
    const harness = createHarness({
      list: () =>
        envelope(0, 'ok', {
          items: [
            { skill_id: 'skill-1', version: 1 },
            { skill_id: 'skill-2', version: 1 },
          ],
          total: 2,
        }),
      delete: (skillId) =>
        skillId === 'skill-2'
          ? envelope(409, 'SKILL_VERSION_CONFLICT', null)
          : envelope(0, 'ok', {}),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as DeleteFailureData;

    expect(status).toBe(500);
    expect(body.code).toBe(500);
    expect(body.message).toBe('SKILL_DELETE_FAILED');
    expect(data.failed_skill_id).toBe('skill-2');
    expect(data.kernel_code).toBe(409);
    expect(data.kernel_message).toBe('SKILL_VERSION_CONFLICT');
    expect(data.deleted_skill_ids).toEqual(['skill-1']);
    // skill 未删完 → agent 绝不 archive，避免留下孤儿 active skill。
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });
});

describe('delete-cascade · 前置守卫', () => {
  it('agent 不存在 → 404 AGENT_NOT_FOUND，不触碰 skill', async () => {
    const harness = createHarness({ agent: () => envelope(404, 'AGENT_NOT_FOUND', null) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.message).toBe('AGENT_NOT_FOUND');
    expect(harness.timeline).toEqual(['meta:auth/verify', 'meta:agent/get']);
  });

  it('caller 不是 agent owner → 403 NOT_YOUR_AGENT，不触碰 skill 与 archive', async () => {
    const harness = createHarness({
      agent: () =>
        envelope(0, 'ok', {
          agent_id: AGENT_ID,
          team_id: TEAM_ID,
          owner_user_id: 'someone-else',
          status: 'active',
        }),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(403);
    expect(body.message).toBe('NOT_YOUR_AGENT');
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('缺少 agent_id → 400 MISSING_AGENT_ID', async () => {
    const harness = createHarness();

    const { status, body } = await deleteCascade(harness, {});

    expect(status).toBe(400);
    expect(body.message).toBe('MISSING_AGENT_ID');
    expect(harness.timeline).toEqual([]);
  });
});
