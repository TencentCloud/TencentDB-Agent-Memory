/**
 * /api/v1/agent/delete-cascade 路由级回归测试（issue #1218）。
 *
 * 现象：该路由在归档 agent 前会无条件先拉 skill/list、再逐条 skill/delete。MemoryCore
 * 未启用 SkillCore 时 skill/list 回的是模块级「能力缺失」信封（404 +
 * "Skill module not enabled"），修复前被原样透传 —— 即便 agent 名下**一个 skill 都没有**
 * 也永远走不到 meta/agent/archive，删除被 404 阻断。
 *
 * 本文件覆盖的行为矩阵（每一格都断言了内核调用时间线，而不只是返回码）：
 *   1. 首页命中能力缺失 → 当作空 skill 集合，不调 skill/delete，直接 archive；
 *   2. fail-closed → 无关 404（message 不同）、文案只是被包含、500 等一律原样透传，
 *      不删 skill、不 archive；
 *   3. 分页中途才回能力缺失 → 自相矛盾响应，fail-closed；
 *   4. 正常路径 → 先逐条 skill/delete（只删 active 页返回的条目），全部成功后才 archive；
 *   5. skill/delete 失败 → 立即中断、不 archive，返回失败信息与已删清单。
 *
 * 做法：不起 HTTP server，把路由挂到独立 Hono app；用最小 fake PanelDeps（只实现本路由
 * 会碰到的 metaKernel / skillKernel 两个端口），并以 timeline 数组记录内核调用的先后顺序
 * ——「skill 全部删完才 archive」是这条路由的核心不变量，只看返回值无法证明。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerAgentLifecycleRoutes } from '../../src/panel/http/routes/agent-lifecycle.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';

const INSTANCE_ID = 'inst-test';
const USER_KEY = 'user-key-test';
const CALLER_ID = 'user-caller';
const AGENT_ID = 'agent-1';
const TEAM_ID = 'team-1';

/** 与 MemoryCore/src/gateway/skill-handlers.ts 的 errorEnvelope(404, ...) 逐字一致。 */
const SKILL_MODULE_ABSENT_CODE = 404;
const SKILL_MODULE_ABSENT_MESSAGE = 'Skill module not enabled';

interface SkillRow {
  skill_id: string;
  version: number;
}

interface CascadeData {
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

function env<T>(code: number, message: string, data: T): MetaEnvelope<T> {
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
  /** skill/list 响应；index 从 0 递增，offset 是本次请求的分页偏移。默认空页。 */
  list?: (call: { index: number; offset: number }) => MetaEnvelope<unknown>;
  /** skill/delete 响应；默认成功。 */
  delete?: (skillId: string, version: number) => MetaEnvelope<unknown>;
  /** agent/archive 响应；默认成功。 */
  archive?: () => MetaEnvelope<unknown>;
  /** agent/get 响应；默认返回归属 CALLER_ID 的 active agent。 */
  agent?: () => MetaEnvelope<unknown>;
}

interface Harness {
  app: Hono;
  /** 内核调用时间线，例如 'skill:delete:skill-1'。 */
  timeline: string[];
  /** 每次 skill/list 的 offset，用于断言分页步长。 */
  listOffsets: number[];
  /** 实际发起 skill/delete 的 skill_id（含失败那条）。 */
  deleteIds: string[];
  /** 实际发起 skill/delete 的 expected_version（必须来自 list 行）。 */
  deleteVersions: number[];
  /** skill/list 请求体，用于断言只查 active。 */
  listRequests: Record<string, unknown>[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const timeline: string[] = [];
  const listOffsets: number[] = [];
  const deleteIds: string[] = [];
  const deleteVersions: number[] = [];
  const listRequests: Record<string, unknown>[] = [];

  const metaKernel = {
    async invoke(action: string): Promise<MetaEnvelope<unknown>> {
      timeline.push(`meta:${action}`);
      if (action === 'auth/verify') {
        return env(0, 'ok', { valid: true, user: { user_id: CALLER_ID } });
      }
      if (action === 'agent/get') {
        return (
          options.agent?.() ??
          env(0, 'ok', {
            agent_id: AGENT_ID,
            team_id: TEAM_ID,
            owner_user_id: CALLER_ID,
            status: 'active',
          })
        );
      }
      if (action === 'agent/archive') {
        return options.archive?.() ?? env(0, 'ok', { archived: true });
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
        listRequests.push(body);
        return (
          options.list?.({ index: listOffsets.length - 1, offset }) ??
          env(0, 'ok', { items: [], total: 0 })
        );
      }
      if (action === 'delete') {
        const skillId = body.skill_id as string;
        const version = body.expected_version as number;
        timeline.push(`skill:delete:${skillId}`);
        deleteIds.push(skillId);
        deleteVersions.push(version);
        return options.delete?.(skillId, version) ?? env(0, 'ok', { deleted: true });
      }
      throw new Error(`unexpected skill action: ${action}`);
    },
  };

  // 只实现本路由实际用到的字段；其余依赖用 as unknown 断言，避免测试耦合无关配置。
  const deps = {
    config: { auth: { sessionCookieName: 'panel_session' }, metadataRemoteTimeoutMs: 30_000 },
    logger: silentLogger(),
    instanceRegistry: {
      resolve: (instanceId: string) => {
        if (instanceId !== INSTANCE_ID) throw new Error(`unknown instance ${instanceId}`);
        return {
          instance_id: INSTANCE_ID,
          name: 'test-instance',
          gateway_endpoint: 'http://kernel.invalid',
          api_key: 'test-api-key',
        };
      },
    },
    metaKernel,
    skillKernel,
    auth: { resolveSession: () => null },
  } as unknown as PanelDeps;

  const api = new Hono();
  // 生产里 reqId 由 requestLogger 注入；这里补最小等价物。
  api.use('*', async (c, next) => {
    c.set('reqId', c.req.header('x-request-id') ?? 'req-test');
    await next();
  });
  registerAgentLifecycleRoutes(api, deps);

  const app = new Hono();
  app.route('/api/v1', api);
  return { app, timeline, listOffsets, deleteIds, deleteVersions, listRequests };
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

describe('delete-cascade · SkillCore 未启用（#1218 回归）', () => {
  it('首页 404 "Skill module not enabled" → 视为空 skill 集合，不删 skill、archive 成功', async () => {
    const harness = createHarness({
      list: () => env(SKILL_MODULE_ABSENT_CODE, SKILL_MODULE_ABSENT_MESSAGE, undefined),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as CascadeData;

    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(data.archived).toBe(true);
    expect(data.agent_id).toBe(AGENT_ID);
    expect(data.deleted_skill_count).toBe(0);
    expect(data.deleted_skill_ids).toEqual([]);

    // 核心不变量：能力缺失不产生任何 skill/delete，且 archive 确实被调用、顺序正确。
    expect(harness.deleteIds).toEqual([]);
    expect(harness.listOffsets).toEqual([0]);
    expect(harness.timeline).toEqual([
      'meta:auth/verify',
      'meta:agent/get',
      'skill:list@0',
      'meta:agent/archive',
    ]);
  });

  it('能力缺失文案带前后空白（trim 后全等）同样按空集合继续', async () => {
    const harness = createHarness({
      list: () => env(404, `  ${SKILL_MODULE_ABSENT_MESSAGE}\n`, undefined),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(200);
    expect((body.data as CascadeData).archived).toBe(true);
    expect(harness.timeline.at(-1)).toBe('meta:agent/archive');
  });
});

describe('delete-cascade · fail-closed：只放行精确的能力缺失', () => {
  it('同为 404 但 message 不同 → 原样透传，不删 skill、不 archive', async () => {
    const harness = createHarness({ list: () => env(404, 'Skill not found', undefined) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.code).toBe(404);
    expect(body.message).toBe('Skill not found');
    expect(harness.deleteIds).toEqual([]);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('message 仅包含能力缺失文案（非全等）→ 不放行', async () => {
    const harness = createHarness({
      list: () => env(404, 'Skill module not enabled for tenant', undefined),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.message).toBe('Skill module not enabled for tenant');
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('code 不是 404（如 500）即便文案相同也不降级', async () => {
    const harness = createHarness({
      list: () => env(500, SKILL_MODULE_ABSENT_MESSAGE, undefined),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(500);
    expect(body.message).toBe(SKILL_MODULE_ABSENT_MESSAGE);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('SkillCore 可用但 list 失败（500）→ 原样透传，不 archive', async () => {
    const harness = createHarness({ list: () => env(500, 'SKILL_LIST_FAILED', undefined) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(500);
    expect(body.code).toBe(500);
    expect(body.message).toBe('SKILL_LIST_FAILED');
    expect(harness.deleteIds).toEqual([]);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('分页中途（offset>0）才回能力缺失 → 自相矛盾响应，fail-closed', async () => {
    // 能力缺失是模块级属性，不可能「第一页正常有数据、第二页说模块没启用」。若按空集合
    // 继续归档，第一页已列出的 skill 没被删除，会变成孤儿 active skill —— 正好违背本路由
    // 的存在意义。所以必须原样透传、什么都不删、不 archive。
    const firstPage: SkillRow[] = Array.from({ length: 100 }, (_, i) => ({
      skill_id: `skill-${i + 1}`,
      version: 1,
    }));
    const harness = createHarness({
      list: ({ index }) =>
        index === 0
          ? env(0, 'ok', { items: firstPage, total: firstPage.length + 1 })
          : env(SKILL_MODULE_ABSENT_CODE, SKILL_MODULE_ABSENT_MESSAGE, undefined),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.code).toBe(SKILL_MODULE_ABSENT_CODE);
    expect(body.message).toBe(SKILL_MODULE_ABSENT_MESSAGE);
    expect(harness.listOffsets).toEqual([0, 100]);
    expect(harness.deleteIds).toEqual([]);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });
});

describe('delete-cascade · 正常路径：先逐条删 skill 再 archive', () => {
  it('只删 active 列表里的 skill，顺序为 list → delete×N → archive', async () => {
    const skills: SkillRow[] = [
      { skill_id: 'skill-1', version: 3 },
      { skill_id: 'skill-2', version: 1 },
    ];
    const harness = createHarness({
      list: () => env(0, 'ok', { items: skills, total: skills.length }),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as CascadeData;

    expect(status).toBe(200);
    expect(body.code).toBe(0);
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
    // 逐条删除必须带 list 返回的 expected_version（乐观锁），且只请求 active 状态。
    expect(harness.deleteVersions).toEqual([3, 1]);
    expect(harness.listRequests[0]?.filters).toEqual({ status: ['active'] });
    expect(harness.listRequests[0]?.agent_id).toBe(AGENT_ID);
  });

  it('skill 跨多页时按 100 步长拉全，全删完才 archive', async () => {
    const harness = createHarness({
      list: ({ index }) =>
        index === 0
          ? env(0, 'ok', { items: [{ skill_id: 'skill-1', version: 1 }], total: 2 })
          : env(0, 'ok', { items: [{ skill_id: 'skill-2', version: 2 }], total: 2 }),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(200);
    expect(harness.listOffsets).toEqual([0, 100]);
    expect(harness.deleteIds).toEqual(['skill-1', 'skill-2']);
    expect((body.data as CascadeData).deleted_skill_ids).toEqual(['skill-1', 'skill-2']);
    expect(harness.timeline.at(-1)).toBe('meta:agent/archive');
  });
});

describe('delete-cascade · skill/delete 失败仍然 fail-closed', () => {
  it('中途 delete 失败 → 500 + 失败信息 + 已删清单，中断且不 archive', async () => {
    const harness = createHarness({
      list: () =>
        env(0, 'ok', {
          items: [
            { skill_id: 'skill-1', version: 1 },
            { skill_id: 'skill-2', version: 4 },
            { skill_id: 'skill-3', version: 1 },
          ],
          total: 3,
        }),
      delete: (skillId) =>
        skillId === 'skill-2' ? env(409, 'VERSION_CONFLICT', undefined) : env(0, 'ok', {}),
    });

    const { status, body } = await deleteCascade(harness);
    const data = body.data as DeleteFailureData;

    expect(status).toBe(500);
    expect(body.code).toBe(500);
    expect(body.message).toBe('SKILL_DELETE_FAILED');
    expect(data.failed_skill_id).toBe('skill-2');
    expect(data.kernel_code).toBe(409);
    expect(data.kernel_message).toBe('VERSION_CONFLICT');
    expect(data.deleted_skill_ids).toEqual(['skill-1']);

    // 失败即中断：skill-3 不再尝试；agent 绝不 archive，避免留下孤儿 active skill。
    expect(harness.deleteIds).toEqual(['skill-1', 'skill-2']);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('archive 失败 → 原样透传内核错误（skill 已删完）', async () => {
    const harness = createHarness({
      list: () => env(0, 'ok', { items: [{ skill_id: 'skill-1', version: 1 }], total: 1 }),
      archive: () => env(500, 'ARCHIVE_FAILED', undefined),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(500);
    expect(body.message).toBe('ARCHIVE_FAILED');
    expect(harness.deleteIds).toEqual(['skill-1']);
    expect(harness.timeline.at(-1)).toBe('meta:agent/archive');
  });
});

describe('delete-cascade · 前置守卫（不触碰 skill 与 archive）', () => {
  it('agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
    const harness = createHarness({ agent: () => env(404, 'AGENT_NOT_FOUND', undefined) });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(404);
    expect(body.message).toBe('AGENT_NOT_FOUND');
    expect(harness.timeline).toEqual(['meta:auth/verify', 'meta:agent/get']);
  });

  it('caller 不是 agent owner → 403 NOT_YOUR_AGENT', async () => {
    const harness = createHarness({
      agent: () =>
        env(0, 'ok', {
          agent_id: AGENT_ID,
          team_id: TEAM_ID,
          owner_user_id: 'someone-else',
          status: 'active',
        }),
    });

    const { status, body } = await deleteCascade(harness);

    expect(status).toBe(403);
    expect(body.message).toBe('NOT_YOUR_AGENT');
    expect(harness.deleteIds).toEqual([]);
    expect(harness.timeline).not.toContain('meta:agent/archive');
  });

  it('缺少 agent_id → 400 MISSING_AGENT_ID，不调内核', async () => {
    const harness = createHarness();

    const { status, body } = await deleteCascade(harness, {});

    expect(status).toBe(400);
    expect(body.message).toBe('MISSING_AGENT_ID');
    expect(harness.timeline).toEqual([]);
  });
});