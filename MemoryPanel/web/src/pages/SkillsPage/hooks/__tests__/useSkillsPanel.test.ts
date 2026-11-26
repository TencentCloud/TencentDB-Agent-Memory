/**
 * useSkillsPanel 关键词过滤用例。
 *
 * 纯函数与通用面板的用例都绿，也不代表 wiring 正确 —— `items={filteredSkills}`、
 * 计数分支、选中清理挂在哪个列表上，任一处写错都不会被现有用例发现。
 * 这里把服务层整体 mock 掉，只验证三条契约：
 *   1. 输入关键词是纯前端行为，不会触发任何列表请求；
 *   2. 过滤把选中项隐藏后，selectedSkillId / selectedSkill 仍然保留；
 *   3. isFiltering 只在「有关键词且原列表非空」时为 true（空列表要表达"无数据"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SkillSummary } from '@/lib/api/skill-api';
import { useSkillsPanel } from '../useSkillsPanel';

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  agentsList: vi.fn(),
  assetsList: vi.fn(),
  assetsListAccessible: vi.fn(),
  preload: vi.fn(async () => undefined),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

vi.mock('@/lib/api/skill-api', () => ({
  listSkills: mocks.listSkills,
  getSkill: vi.fn(),
  deleteSkillV3: vi.fn(),
  exportSkill: vi.fn(),
}));

vi.mock('@/lib/teamApi', () => ({
  assetsApi: { list: mocks.assetsList, listAccessible: mocks.assetsListAccessible },
  agentsApi: { list: mocks.agentsList },
}));

vi.mock('@/services', () => ({
  useTeams: () => ({ activeTeamId: 'team_1', activeTeam: { name: 'Team' } }),
}));

vi.mock('@/services/use-skill-detail-cache', () => ({
  useSkillDetailCache: () => ({
    applyCachedDetail: (skill: SkillSummary) => skill,
    preload: mocks.preload,
    cacheVersion: 0,
  }),
}));

vi.mock('@/lib/panelSession', () => ({
  getPanelSession: () => ({ user: { user_id: 'user_1' } }),
}));

vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify: { error: mocks.notifyError, warning: mocks.notifyWarning } },
}));

// t 的引用必须稳定：refresh 的依赖数组里有 t，每次渲染换新函数会让 effect 反复触发。
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

function makeSkill(id: string, name: string): SkillSummary {
  return {
    skill_id: id,
    name,
    description: '',
    version: 1,
    is_head: true,
    status: 'active',
    owner_user_id: 'user_1',
    owner_agent_id: 'agent_1',
    team_id: 'team_1',
    task_id: '',
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

const ALPHA = makeSkill('sk_alpha', 'Alpha Skill');
const BETA = makeSkill('sk_beta', 'Beta Skill');

function mockSkillList(skills: SkillSummary[]) {
  mocks.listSkills.mockImplementation(
    async ({ pagination }: { pagination?: { limit?: number; offset?: number } }) => {
      const limit = pagination?.limit ?? 100;
      const offset = pagination?.offset ?? 0;
      return { items: skills.slice(offset, offset + limit), total: skills.length };
    },
  );
}

async function renderLoaded(skills: SkillSummary[]) {
  mockSkillList(skills);
  const view = renderHook(() => useSkillsPanel());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentsList.mockResolvedValue([
    { agent_id: 'agent_1', name: 'Agent One', owner_user_id: 'user_1' },
  ]);
  mocks.assetsList.mockResolvedValue([]);
  mocks.assetsListAccessible.mockResolvedValue([]);
});

describe('useSkillsPanel 关键词过滤', () => {
  it('输入关键词不触发列表请求，且列表按关键词收敛', async () => {
    const view = await renderLoaded([ALPHA, BETA]);
    await waitFor(() => expect(view.result.current.skills).toHaveLength(2));
    const callsAfterLoad = mocks.listSkills.mock.calls.length;

    act(() => view.result.current.setKeyword('alpha'));

    expect(mocks.listSkills.mock.calls.length).toBe(callsAfterLoad);
    expect(view.result.current.filteredSkills.map((s) => s.skill_id)).toEqual(['sk_alpha']);
    expect(view.result.current.isFiltering).toBe(true);
    // 全量列表不受过滤影响（选中清理与详情都依赖它）
    expect(view.result.current.skillsWithCache).toHaveLength(2);
  });

  it('过滤隐藏选中项时，选中与详情仍然保留', async () => {
    const view = await renderLoaded([ALPHA, BETA]);
    await waitFor(() => expect(view.result.current.skills).toHaveLength(2));

    act(() => view.result.current.setSelectedSkillId('sk_beta'));
    act(() => view.result.current.setKeyword('alpha'));

    expect(view.result.current.filteredSkills.map((s) => s.skill_id)).toEqual(['sk_alpha']);
    expect(view.result.current.selectedSkillId).toBe('sk_beta');
    expect(view.result.current.selectedSkill?.skill_id).toBe('sk_beta');
  });

  it('清空关键词后列表与计数恢复全量', async () => {
    const view = await renderLoaded([ALPHA, BETA]);
    await waitFor(() => expect(view.result.current.skills).toHaveLength(2));

    act(() => view.result.current.setKeyword('  '));
    expect(view.result.current.isFiltering).toBe(false);
    expect(view.result.current.filteredSkills).toHaveLength(2);

    act(() => view.result.current.setKeyword('beta'));
    expect(view.result.current.isFiltering).toBe(true);
    expect(view.result.current.filteredSkills).toHaveLength(1);

    act(() => view.result.current.setKeyword(''));
    expect(view.result.current.isFiltering).toBe(false);
    expect(view.result.current.filteredSkills).toHaveLength(2);
  });

  it('关键词无命中时 isFiltering 为 true 且列表为空', async () => {
    const view = await renderLoaded([ALPHA, BETA]);
    await waitFor(() => expect(view.result.current.skills).toHaveLength(2));

    act(() => view.result.current.setKeyword('zzz-not-exist'));

    expect(view.result.current.filteredSkills).toEqual([]);
    expect(view.result.current.isFiltering).toBe(true);
  });

  it('原列表为空时即使有关键词也不算过滤态（要显示"无数据"而不是"无匹配"）', async () => {
    const view = await renderLoaded([]);
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    act(() => view.result.current.setKeyword('alpha'));

    expect(view.result.current.filteredSkills).toEqual([]);
    expect(view.result.current.isFiltering).toBe(false);
  });
});
