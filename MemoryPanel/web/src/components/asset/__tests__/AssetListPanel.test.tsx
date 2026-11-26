/**
 * AssetListPanel 用例。
 *
 * 该组件同时被 Skills（新增搜索工具条）与 ChatMemory（未改动）复用，
 * 所以用例重点在「新增的三个可选 prop 不影响既有默认行为」：
 *   1. 不传 toolbar → 不渲染工具条（ChatMemory 回归）；
 *   2. 传 toolbar → 位于标题行之后、列表之前；
 *   3. 空态优先级：isFiltering + filteredEmptyText 优先，缺省回退 emptyText；
 *   4. loading 优先于空态，count 在 loading 时隐藏。
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { AssetListPanel } from '../AssetListPanel';

interface Item {
  id: string;
  label: string;
}

const items: Item[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

interface PanelOverrides {
  title?: ReactNode;
  count?: ReactNode;
  loading?: boolean;
  items?: Item[];
  selectedId?: string | null;
  emptyText?: ReactNode;
  toolbar?: ReactNode;
  isFiltering?: boolean;
  filteredEmptyText?: ReactNode;
}

function renderPanel(overrides: PanelOverrides = {}) {
  return render(
    <AssetListPanel<Item>
      title="列表"
      count="2 条"
      items={items}
      getItemId={(item) => item.id}
      onSelect={() => {}}
      renderItem={(item) => <span>{item.label}</span>}
      emptyText="暂无数据"
      {...overrides}
    />,
  );
}

describe('AssetListPanel', () => {
  it('不传 toolbar 时不渲染工具条容器', () => {
    const { container } = renderPanel();

    expect(container.querySelector('._alp-toolbar')).toBeNull();
    expect(container.querySelector('._alp-header')?.nextElementSibling?.tagName).toBe('UL');
  });

  it('传 toolbar 时渲染在标题行之后、列表之前', () => {
    const { container, getByPlaceholderText, getByText } = renderPanel({
      toolbar: <input placeholder="搜索" />,
    });

    const header = container.querySelector('._alp-header');
    const toolbar = container.querySelector('._alp-toolbar');
    expect(header?.nextElementSibling).toBe(toolbar);
    expect(getByPlaceholderText('搜索')).toBeTruthy();
    if (!toolbar) throw new Error('toolbar 未渲染');
    // 用文档顺序而不是 tagName 断言：内部容器换成 div/ul 都不该让用例失效。
    expect(
      toolbar.compareDocumentPosition(getByText('Alpha')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('默认渲染全部条目且展示计数', () => {
    const { container, getByText } = renderPanel();

    expect(container.querySelectorAll('._alp-item')).toHaveLength(2);
    expect(getByText('2 条')).toBeTruthy();
  });

  it('loading 时显示 4 个骨架、隐藏计数、不显示空态', () => {
    const { container, queryByText } = renderPanel({ loading: true, items: [] });

    expect(container.querySelectorAll('._alp-skeleton')).toHaveLength(4);
    expect(queryByText('2 条')).toBeNull();
    expect(queryByText('暂无数据')).toBeNull();
  });

  it('空列表且未标记过滤态时显示 emptyText', () => {
    const { container } = renderPanel({ items: [] });

    expect(container.querySelector('._alp-empty')?.textContent).toBe('暂无数据');
  });

  it('过滤态 + filteredEmptyText 时优先显示过滤空态', () => {
    const { container } = renderPanel({
      items: [],
      isFiltering: true,
      filteredEmptyText: '没有匹配项',
    });

    expect(container.querySelector('._alp-empty')?.textContent).toBe('没有匹配项');
  });

  it('过滤态但未提供 filteredEmptyText 时回退 emptyText', () => {
    const { container } = renderPanel({ items: [], isFiltering: true });

    expect(container.querySelector('._alp-empty')?.textContent).toBe('暂无数据');
  });

  it('有数据时过滤标记不影响列表渲染', () => {
    const { container } = renderPanel({
      isFiltering: true,
      filteredEmptyText: '没有匹配项',
    });

    expect(container.querySelectorAll('._alp-item')).toHaveLength(2);
    expect(container.querySelector('._alp-empty')).toBeNull();
  });

  it('选中项带选中态类名', () => {
    const { container } = renderPanel({ selectedId: 'b' });

    const selected = container.querySelector('._alp-item--selected');
    expect(selected?.textContent).toContain('Beta');
  });
});
