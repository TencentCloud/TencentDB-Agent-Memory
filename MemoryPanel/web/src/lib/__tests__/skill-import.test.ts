/**
 * 同名探测判定（pickSameNameSkill / namePrefixOf）的用例。
 *
 * 关键风险点：`skill/list` 的 name_prefix 是前缀匹配，若前端不做全等二次过滤，
 * `code-review` 导入会被 `code-review-helper` 拦下来弹"替换确认"，进而把别人的
 * skill 当成自己的同名 skill 处理。
 */
import { describe, expect, it } from 'vitest';
import { namePrefixOf, pickSameNameSkill } from '@/lib/skill-import';
import type { SkillSummary } from '@/lib/api/skill-api';

function summary(patch: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    skill_id: 'skl-1',
    description: '',
    version: 1,
    is_head: true,
    status: 'active',
    owner_user_id: 'u-1',
    owner_agent_id: 'agt-1',
    team_id: 'team-1',
    task_id: '',
    created_at_ms: 0,
    updated_at_ms: 0,
    ...patch,
  };
}

describe('pickSameNameSkill', () => {
  it('精确同名命中', () => {
    const hit = pickSameNameSkill(
      [summary({ name: 'code-review', skill_id: 'skl-a' }), summary({ name: 'other' })],
      'code-review',
    );
    expect(hit?.skill_id).toBe('skl-a');
  });

  it('仅前缀相同不算同名', () => {
    expect(
      pickSameNameSkill([summary({ name: 'code-review-helper' })], 'code-review'),
    ).toBeNull();
  });

  it('archived 同名不触发替换', () => {
    expect(
      pickSameNameSkill([summary({ name: 'code-review', status: 'archived' })], 'code-review'),
    ).toBeNull();
  });

  it('空列表 / 空名字返回 null', () => {
    expect(pickSameNameSkill([], 'code-review')).toBeNull();
    expect(pickSameNameSkill([summary({ name: 'code-review' })], '   ')).toBeNull();
  });

  it('名字前后空白不影响匹配（frontmatter 提取时的残留）', () => {
    const hit = pickSameNameSkill([summary({ name: 'code-review' })], ' code-review ');
    expect(hit?.name).toBe('code-review');
  });
});

describe('namePrefixOf', () => {
  it('原样返回并去掉首尾空白', () => {
    expect(namePrefixOf(' code-review ')).toBe('code-review');
  });
});
