/**
 * 面板页签保活 —— 纯逻辑回归测试（node 环境，无 DOM / React 依赖）。
 *
 * 覆盖：
 *   - constants/routes：路径归一化、最长前缀 + 段边界匹配、未知路径回落、/guide 判定；
 *   - layouts/keepalive-state：缓存保留规则（关闭标签 = 丢弃、/guide 期间保留）与帧可见性属性。
 *
 * 组件级行为（切换后滚动/选中保留、关闭重开重置、/guide 往返保留）见 PR 描述中的人工验收步骤。
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PAGE,
  PAGE_TO_PATH,
  PATH_TO_PAGE,
  isGuidePath,
  normalizePathname,
  resolveActivePage,
} from '../../web/src/constants/routes';
import { frameVisibility, retainedPageIds } from '../../web/src/layouts/keepalive-state';

describe('normalizePathname', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['wiki', '/wiki'],
    ['/wiki/', '/wiki'],
    ['//team//members//', '/team/members'],
    ['/skills?tab=fixed', '/skills'],
    ['/memory#anchor', '/memory'],
    ['  /code  ', '/code'],
  ])('%j → %j', (input, expected) => {
    expect(normalizePathname(input)).toBe(expected);
  });
});

describe('resolveActivePage', () => {
  it('maps every registered path to its own PageId (round-trip with PAGE_TO_PATH)', () => {
    for (const [path, id] of Object.entries(PATH_TO_PAGE)) {
      expect(resolveActivePage(path)).toBe(id);
      expect(PAGE_TO_PATH[id]).toBe(path);
    }
  });

  it('normalizes trailing slashes, duplicate slashes and query strings', () => {
    expect(resolveActivePage('/skills/')).toBe('skills');
    expect(resolveActivePage('//memory')).toBe('chat_memory');
    expect(resolveActivePage('/team/api-keys?x=1')).toBe('api_keys');
  });

  it('matches nested segments under a registered prefix', () => {
    expect(resolveActivePage('/wiki/abc')).toBe('wiki');
    expect(resolveActivePage('/team/agents/a-1/detail')).toBe('team_agents');
  });

  it('respects segment boundaries (no partial-word prefix match)', () => {
    expect(resolveActivePage('/wikis')).toBe(FALLBACK_PAGE);
    expect(resolveActivePage('/codex')).toBe(FALLBACK_PAGE);
    expect(resolveActivePage('/team/membership')).toBe(FALLBACK_PAGE);
  });

  it('falls back to the workbench for unknown or root paths', () => {
    expect(FALLBACK_PAGE).toBe('workbench_board');
    expect(resolveActivePage('/')).toBe('workbench_board');
    expect(resolveActivePage('')).toBe('workbench_board');
    expect(resolveActivePage('/does-not-exist')).toBe('workbench_board');
    expect(resolveActivePage('/team')).toBe('workbench_board');
  });
});

describe('isGuidePath', () => {
  it('detects the standalone guide page only', () => {
    expect(isGuidePath('/guide')).toBe(true);
    expect(isGuidePath('/guide/')).toBe(true);
    expect(isGuidePath('/guides')).toBe(false);
    expect(isGuidePath('/wiki')).toBe(false);
  });
});

describe('retainedPageIds', () => {
  it('keeps open tabs in first-visit order (switching tabs never drops a frame)', () => {
    expect(
      retainedPageIds(['workbench_board', 'skills', 'chat_memory'], ['workbench_board', 'chat_memory', 'skills'], 'skills'),
    ).toEqual(['workbench_board', 'skills', 'chat_memory']);
  });

  it('drops the frame of a closed tab (close = reset)', () => {
    expect(
      retainedPageIds(['workbench_board', 'skills', 'chat_memory'], ['workbench_board', 'chat_memory'], 'chat_memory'),
    ).toEqual(['workbench_board', 'chat_memory']);
  });

  it('keeps the active page even before ConsoleLayout appends it to openPages', () => {
    expect(retainedPageIds(['workbench_board', 'wiki'], ['workbench_board'], 'wiki')).toEqual([
      'workbench_board',
      'wiki',
    ]);
  });

  it('keeps every open frame while /guide is shown (activePage = null)', () => {
    expect(retainedPageIds(['workbench_board', 'skills'], ['workbench_board', 'skills'], null)).toEqual([
      'workbench_board',
      'skills',
    ]);
  });

  it('a reopened tab is not resurrected from a stale cache entry', () => {
    // 关闭 skills → 下一轮渲染裁剪掉它；之后重开时缓存里已没有旧帧
    const afterClose = retainedPageIds(['workbench_board', 'skills'], ['workbench_board'], 'workbench_board');
    expect(afterClose).not.toContain('skills');
  });
});

describe('frameVisibility', () => {
  it('active frame carries no hiding attributes', () => {
    const v = frameVisibility(true);
    expect(v['aria-hidden']).toBeUndefined();
    expect(v.inert).toBe(false);
    expect(v.style).toEqual({ visibility: 'visible', pointerEvents: 'auto', zIndex: 1 });
  });

  it('hidden frame uses visibility (not display:none), aria-hidden, inert and no pointer events', () => {
    const v = frameVisibility(false);
    expect(v['aria-hidden']).toBe(true);
    expect(v.inert).toBe(true);
    expect(v.style.visibility).toBe('hidden');
    expect(v.style.pointerEvents).toBe('none');
    expect(v.style).not.toHaveProperty('display');
  });
});
