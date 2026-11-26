/**
 * asset-common 关键词工具用例。
 *
 * 覆盖 Skills 页搜索的匹配语义：
 *   1. 归一化（首尾空白 / 大小写 / null / 纯空白）；
 *   2. 空关键词绝不过滤（并保持数组引用，避免 useMemo 下游重渲染）；
 *   3. name / skill_id / description / owner_user_id 任一子串命中；
 *   4. 字段缺失或为 null 时不抛错、不误命中。
 */
import { describe, expect, it } from 'vitest';
import {
  filterSkillsByKeyword,
  matchesSkillKeyword,
  normalizeKeyword,
  type SkillKeywordFields,
} from '../asset-common';

const base: SkillKeywordFields = {
  name: 'Code Review',
  skill_id: 'sk_001',
  description: '审查 PR 的技能',
  owner_user_id: 'user_abc',
};

describe('normalizeKeyword', () => {
  it('去除首尾空白并转小写', () => {
    expect(normalizeKeyword('  Hello ')).toBe('hello');
  });

  it('null / undefined / 空串 / 纯空白都归一化为空串', () => {
    expect(normalizeKeyword(null)).toBe('');
    expect(normalizeKeyword(undefined)).toBe('');
    expect(normalizeKeyword('')).toBe('');
    expect(normalizeKeyword('   ')).toBe('');
  });
});

describe('matchesSkillKeyword', () => {
  it('空关键词恒为 true', () => {
    expect(matchesSkillKeyword(base, '')).toBe(true);
    expect(matchesSkillKeyword(base, '   ')).toBe(true);
    expect(matchesSkillKeyword({}, null)).toBe(true);
  });

  it('命中 name，且大小写不敏感', () => {
    expect(matchesSkillKeyword(base, 'CODE')).toBe(true);
    expect(matchesSkillKeyword(base, 'review')).toBe(true);
  });

  it('命中 skill_id 子串', () => {
    expect(matchesSkillKeyword(base, 'sk_00')).toBe(true);
  });

  it('命中 description 中的中文子串', () => {
    expect(matchesSkillKeyword(base, '审查')).toBe(true);
  });

  it('命中 owner_user_id 子串', () => {
    expect(matchesSkillKeyword(base, 'abc')).toBe(true);
  });

  it('关键词带首尾空白与混合大小写仍能命中', () => {
    expect(matchesSkillKeyword(base, '  CoDe  ')).toBe(true);
  });

  it('全部字段缺失或为 null 时返回 false 且不抛错', () => {
    expect(matchesSkillKeyword({}, 'anything')).toBe(false);
    expect(matchesSkillKeyword({ name: null, skill_id: null }, 'anything')).toBe(false);
  });

  it('无命中时返回 false', () => {
    expect(matchesSkillKeyword(base, 'not-exist')).toBe(false);
  });
});

describe('filterSkillsByKeyword', () => {
  const list: SkillKeywordFields[] = [
    { name: 'Alpha', skill_id: 'sk_1', description: 'first' },
    { name: 'Beta', skill_id: 'sk_2', description: 'second' },
    { name: 'Gamma', skill_id: 'sk_3', description: 'alpha related' },
  ];

  it('空关键词返回入参同一引用', () => {
    expect(filterSkillsByKeyword(list, '')).toBe(list);
    expect(filterSkillsByKeyword(list, '  ')).toBe(list);
    expect(filterSkillsByKeyword(list, undefined)).toBe(list);
  });

  it('保留原顺序', () => {
    expect(filterSkillsByKeyword(list, 'a').map((s) => s.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('多字段混合命中都保留', () => {
    // Alpha 命中 name，Gamma 命中 description
    expect(filterSkillsByKeyword(list, 'alpha').map((s) => s.name)).toEqual(['Alpha', 'Gamma']);
  });

  it('无命中返回空数组', () => {
    expect(filterSkillsByKeyword(list, 'zzz')).toEqual([]);
  });

  it('不修改入参数组', () => {
    const snapshot = [...list];
    filterSkillsByKeyword(list, 'alpha');
    expect(list).toEqual(snapshot);
    expect(list).toHaveLength(3);
  });

  it('空数组 + 任意关键词返回空数组', () => {
    expect(filterSkillsByKeyword([], 'x')).toEqual([]);
  });
});
