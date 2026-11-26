/**
 * KeepAlivePages 用例。
 *
 * 覆盖需求「面板各标签页交替切换保留进度」的核心契约：
 *   1. 切走再切回，页面内状态（输入值，代表一切 useState）不丢；
 *   2. 非激活帧被标记为 data-frame-active="false"（visibility 由 CSS 负责隐藏）；
 *   3. 关闭页签后重新打开，状态归零（关标签 = 重置页面）；
 *   4. /guide 独立页不占页签帧，但也不销毁已缓存的帧；
 *   5. usePageActive() 能准确反映可见性（后台轮询据此暂停）。
 */
import { useEffect, useState } from 'react';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KeepAlivePages } from '@/layouts/KeepAlivePages';
import { usePageActive } from '@/lib/page-active';
import { resolveActivePage } from '@/constants/routes';
import type { PageId } from '@/constants/menu';

/** 被测页面：一个受控输入 + 可见性展示，用来观测 remount 是否会丢状态。 */
function ProbePage({ label }: { label: string }) {
  const [value, setValue] = useState('');
  const active = usePageActive();
  return (
    <div>
      <span>{label} page</span>
      <input
        aria-label={`${label}-input`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span data-testid={`${label}-active`}>{active ? 'active' : 'hidden'}</span>
    </div>
  );
}

/** 模拟 ConsoleLayout：维护 openPages，提供切页 / 关页能力。 */
function TestShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isGuide = location.pathname === '/guide';
  const activePage = resolveActivePage(location.pathname);

  // 与 ConsoleLayout 同构：首次进入时 openPages 初始化为当前页，
  // 之后由 effect 追加。
  const [pages, setPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));
  useEffect(() => {
    if (isGuide) return;
    setPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  return (
    <div>
      <button type="button" onClick={() => navigate('/wiki')}>
        go-wiki
      </button>
      <button type="button" onClick={() => navigate('/code')}>
        go-code
      </button>
      <button type="button" onClick={() => navigate('/guide')}>
        go-guide
      </button>
      {!isGuide && (
        <button type="button" onClick={() => setPages((prev) => prev.filter((p) => p !== 'wiki'))}>
          close-wiki
        </button>
      )}
      <KeepAlivePages pages={pages} activePath={location.pathname} isGuide={isGuide} />
    </div>
  );
}

function renderShell(initialPath = '/wiki') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <TestShell />,
        children: [
          { path: 'wiki', element: <ProbePage label="wiki" /> },
          { path: 'code', element: <ProbePage label="code" /> },
          { path: 'guide', element: <div>guide content</div> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  return render(<RouterProvider router={router} />);
}

/** 取某一页对应的 <main> 帧。 */
function frameOf(label: string): HTMLElement {
  const el = screen.getByText(`${label} page`).closest('main');
  if (!el) throw new Error(`${label} 帧未渲染`);
  return el as HTMLElement;
}

/** 往受控 input 里写值（绕过 userEvent 的事件序列开销）。 */
async function typeInto(label: string, text: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('KeepAlivePages', () => {
  it('切走再切回时保留页面内状态', async () => {
    renderShell('/wiki');
    await typeInto('wiki-input', 'draft-text');
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('draft-text');

    await act(async () => {
      screen.getByText('go-code').click();
    });
    await act(async () => {
      screen.getByText('go-wiki').click();
    });

    // 未丢（若被 remount 过，value 会回到空串）
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('draft-text');
  });

  it('非激活帧带 data-frame-active="false"', async () => {
    renderShell('/wiki');
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('true');

    await act(async () => {
      screen.getByText('go-code').click();
    });

    expect(frameOf('code').getAttribute('data-frame-active')).toBe('true');
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('false');
  });

  it('关闭页签后重新打开，状态归零', async () => {
    renderShell('/wiki');
    await typeInto('wiki-input', 'typed');
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('typed');

    // 先切走（否则关掉当前页签没有落点），再关闭 wiki 页签
    await act(async () => {
      screen.getByText('go-code').click();
    });
    await act(async () => {
      screen.getByText('close-wiki').click();
    });
    expect(screen.queryByLabelText('wiki-input')).toBeNull();

    // 重新打开
    await act(async () => {
      screen.getByText('go-wiki').click();
    });
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('');
  });

  it('/guide 不占页签帧，但保留已缓存帧', async () => {
    renderShell('/wiki');
    await typeInto('wiki-input', 'keep-me');

    await act(async () => {
      screen.getByText('go-guide').click();
    });

    expect(screen.getByText('guide content')).toBeInTheDocument();
    // 已缓存的 wiki 帧仍在 DOM（隐藏），只是被标为非激活
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('false');

    // 从 guide 返回 wiki，进度仍在
    await act(async () => {
      screen.getByText('go-wiki').click();
    });
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('keep-me');
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('true');
  });

  it('usePageActive 在隐藏帧内返回 false', async () => {
    renderShell('/wiki');
    expect(screen.getByTestId('wiki-active').textContent).toBe('active');

    await act(async () => {
      screen.getByText('go-code').click();
    });

    expect(screen.getByTestId('wiki-active').textContent).toBe('hidden');
    expect(screen.getByTestId('code-active').textContent).toBe('active');
  });
});
