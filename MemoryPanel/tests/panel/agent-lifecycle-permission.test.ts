/**
 * issue #1321：控制层 admin 代删的权限判定。
 *
 * /agent/delete-cascade 原先硬校验 owner_user_id === caller，导致前端
 * canManageAsset 对 team admin 返回 true、点下去却固定 403。这里锁住放行后的
 * 判定边界：该放行的放行，不该放行的仍旧拒绝。
 */

import { describe, expect, it } from 'vitest';
import {
  isCallerSystemAdmin,
  isCallerTeamAdmin,
} from '../../src/panel/http/routes/knowledge/common.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type { MetaCallContext } from '../../src/panel/kernel/types.js';

const ctx = { userKey: 'caller-key', instanceId: 'inst' } as unknown as MetaCallContext;

/** 构造只实现 metaKernel.invoke 的最小 deps。 */
function depsInvoking(
  handler: (action: string, params: Record<string, unknown>, ctx: MetaCallContext) => Promise<unknown>,
): PanelDeps {
  return { metaKernel: { invoke: handler } } as unknown as PanelDeps;
}

/** 让 team-member/get 返回给定实体，其余动作返回空。 */
function teamMemberReturning(data: unknown, code = 0): PanelDeps {
  return depsInvoking(async (action) =>
    action === 'team-member/get' ? { code, data } : { code: 0, data: null },
  );
}

describe('isCallerTeamAdmin', () => {
  it('role=admin 且 status=active → 放行', async () => {
    const deps = teamMemberReturning({ role: 'admin', status: 'active' });
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', 'user-1')).toBe(true);
  });

  it('role=member → 拒绝（team admin 之外不放行）', async () => {
    const deps = teamMemberReturning({ role: 'member', status: 'active' });
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', 'user-1')).toBe(false);
  });

  it('role=admin 但 status!=active → 拒绝（已退群的管理员不再有权限）', async () => {
    const deps = teamMemberReturning({ role: 'admin', status: 'removed' });
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', 'user-1')).toBe(false);
  });

  it('上游返回非 0 code → 拒绝', async () => {
    const deps = teamMemberReturning({ role: 'admin', status: 'active' }, 500);
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', 'user-1')).toBe(false);
  });

  it('上游抛异常 → 保守拒绝，不放大成越权', async () => {
    const deps = depsInvoking(async () => {
      throw new Error('upstream down');
    });
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', 'user-1')).toBe(false);
  });

  it('teamId / userId 为空 → 直接拒绝，不打上游', async () => {
    const deps = depsInvoking(async () => {
      throw new Error('should not be called');
    });
    expect(await isCallerTeamAdmin(deps, ctx, '', 'user-1')).toBe(false);
    expect(await isCallerTeamAdmin(deps, ctx, 'team-1', '')).toBe(false);
  });
});

describe('isCallerSystemAdmin', () => {
  it('user_type=system_admin → 放行', async () => {
    const deps = depsInvoking(async () => ({
      code: 0,
      data: { valid: true, user: { user_type: 'system_admin' } },
    }));
    expect(await isCallerSystemAdmin(deps, ctx)).toBe(true);
  });

  it('user_type=normal → 拒绝', async () => {
    const deps = depsInvoking(async () => ({
      code: 0,
      data: { valid: true, user: { user_type: 'normal' } },
    }));
    expect(await isCallerSystemAdmin(deps, ctx)).toBe(false);
  });

  it('valid=false → 拒绝', async () => {
    const deps = depsInvoking(async () => ({
      code: 0,
      data: { valid: false, user: { user_type: 'system_admin' } },
    }));
    expect(await isCallerSystemAdmin(deps, ctx)).toBe(false);
  });
});
