import { describe, expect, it, vi } from 'vitest';

import {
  SKILL_NAME_DUPLICATE_CODE,
  createWithReplaceConfirm,
  describeCreateOutcome,
  isSkillNameDuplicateError,
  withReplaceFlag,
} from '../web/src/lib/skill-replace';

/** 与 web/src/lib/api/skill-api.ts 中 SkillApiError 同形（不引入 i18n/浏览器依赖）。 */
class FakeSkillApiError extends Error {
  constructor(public code: number, public rawMessage: string, public requestId = 'req-1') {
    super(`${rawMessage} (request_id: ${requestId})`);
  }
}

const DUP_MSG =
  "SKILL_NAME_DUPLICATE: name 'cc-auto-test-run-case-finalization' already exists for agent in team";

describe('isSkillNameDuplicateError', () => {
  it('按错误码 42201 识别', () => {
    expect(SKILL_NAME_DUPLICATE_CODE).toBe(42201);
    expect(isSkillNameDuplicateError(new FakeSkillApiError(42201, 'whatever'))).toBe(true);
  });

  it('错误码缺失/被改写时按 message 中的 SKILL_NAME_DUPLICATE 兜底', () => {
    expect(isSkillNameDuplicateError(new FakeSkillApiError(502, DUP_MSG))).toBe(true);
    expect(isSkillNameDuplicateError(new Error(DUP_MSG))).toBe(true);
  });

  it('其它错误不识别为同名冲突', () => {
    expect(isSkillNameDuplicateError(new FakeSkillApiError(40001, 'frontmatter invalid'))).toBe(false);
    expect(isSkillNameDuplicateError(new Error('network down'))).toBe(false);
    expect(isSkillNameDuplicateError(null)).toBe(false);
    expect(isSkillNameDuplicateError('SKILL_NAME_DUPLICATE')).toBe(false);
  });
});

describe('withReplaceFlag', () => {
  it('在原参数上追加 replace:true，且不修改原对象', () => {
    const params = { team_id: 't', agent_id: 'a', user_id: 'u', name: 'n', content: 'c' };
    const next = withReplaceFlag(params);
    expect(next).toEqual({ ...params, replace: true });
    expect(params).not.toHaveProperty('replace');
  });
});

describe('describeCreateOutcome', () => {
  it('普通新建', () => {
    expect(describeCreateOutcome({ version: 1 })).toEqual({ kind: 'created', version: 1 });
  });
  it('替换为 vN', () => {
    expect(describeCreateOutcome({ version: 3, replaced: true, previous_version: 2 })).toEqual({
      kind: 'replaced',
      version: 3,
      previousVersion: 2,
    });
  });
  it('命中同名但无变化（版本未递增）', () => {
    expect(describeCreateOutcome({ version: 2, replaced: true, previous_version: 2 })).toEqual({
      kind: 'unchanged',
      version: 2,
    });
  });
});

describe('createWithReplaceConfirm', () => {
  const params = { name: 'cc-auto-test-run-case-finalization', content: '---\n' };

  it('无冲突：只调用一次 create，不弹确认', async () => {
    const create = vi.fn().mockResolvedValue({ version: 1 });
    const confirm = vi.fn();
    const out = await createWithReplaceConfirm(params, create, confirm);
    expect(out).toEqual({ result: { version: 1 }, retriedWithReplace: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(params);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('同名冲突 + 用户确认：带 replace:true 重试一次', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new FakeSkillApiError(42201, DUP_MSG))
      .mockResolvedValueOnce({ version: 2, replaced: true, previous_version: 1 });
    const confirm = vi.fn().mockResolvedValue(true);
    const out = await createWithReplaceConfirm(params, create, confirm);
    expect(out.retriedWithReplace).toBe(true);
    expect(out.result).toEqual({ version: 2, replaced: true, previous_version: 1 });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenNthCalledWith(2, { ...params, replace: true });
  });

  it('同名冲突 + 用户取消：抛出原同名错误，不再调用 create', async () => {
    const dup = new FakeSkillApiError(42201, DUP_MSG);
    const create = vi.fn().mockRejectedValueOnce(dup);
    const confirm = vi.fn().mockResolvedValue(false);
    await expect(createWithReplaceConfirm(params, create, confirm)).rejects.toBe(dup);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('非同名错误：直接上抛，不弹确认', async () => {
    const other = new FakeSkillApiError(4291, 'Memory limit exceeded');
    const create = vi.fn().mockRejectedValueOnce(other);
    const confirm = vi.fn();
    await expect(createWithReplaceConfirm(params, create, confirm)).rejects.toBe(other);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('重试本身失败：上抛重试的错误', async () => {
    const stale = new FakeSkillApiError(40901, 'SKILL_VERSION_STALE');
    const create = vi
      .fn()
      .mockRejectedValueOnce(new FakeSkillApiError(42201, DUP_MSG))
      .mockRejectedValueOnce(stale);
    await expect(createWithReplaceConfirm(params, create, async () => true)).rejects.toBe(stale);
  });
});
