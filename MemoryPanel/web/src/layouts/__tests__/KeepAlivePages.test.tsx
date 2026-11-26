/**
 * KeepAlivePages 用例。
 *
 * 覆盖需求「面板各标签页交替切换保留进度」的核心契约：
 *   1. 切走再切回，页面内状态（输入值 / 滚动位置等 useState 的代理）不丢；
 *   2. 非激活帧被标记为 data-frame-active="false" + aria-hidden；
 *   3. 关闭页签后重新打开，状态归零（关标签 = 重置页面）；
 *   4. /guide 独立页不进缓存，也不污染页签帧；
 *   5. usePageActive() 能准确反映可见性（后台轮询据此暂停）。
 */
import { useEffect, useState } from 'react';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { render, screen, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KeepAlivePages, usePageActive } from '@/layouts/KeepAlivePages';
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
  const [pages, setPages] = useState<PageId[]>(() =>
    isGuide ? [] : [location.pathname === '/code' ? 'code' : 'wiki'],
  );

  // 与 ConsoleLayout 的 activePage effect 同构
  useEffect(() => {
    if (isGuide) return;
    const id: PageId = location.pathname === '/code' ? 'code' : 'wiki';
    setPages((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [location.pathname, isGuide]);

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

describe('KeepAlivePages', () => {
  it('切走再切回时保留页面内状态', async () => {
    const { container } = renderShell('/wiki');
    const input = screen.getByLabelText('wiki-input') as HTMLInputElement;

    await act(async () => {
      input.focus();
      // 直接派发 input 事件走受控组件路径
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'draft-text');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('draft-text');

    // 切到 code
    await act(async () => {
      screen.getByText('go-code').click();
    });
    // 再切回 wiki
    await act(async () => {
      screen.getByText('go-wiki').click();
    });

    // 状态未丢（若被 remount 过，value 会回到空串）
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('draft-text');
    expect(container.querySelectorAll('main').length).toBeGreaterThanOrEqual(2);
  });

  it('非激活帧带 data-frame-active="false" 且 aria-hidden', async () => {
    renderShell('/wiki');
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('true');
    expect(frameOf('wiki').getAttribute('aria-hidden')).toBeNull();

    await act(async () => {
      screen.getByText('go-code').click();
    });

    expect(frameOf('code').getAttribute('data-frame-active')).toBe('true');
    expect(frameOf('wiki').getAttribute('data-frame-active')).toBe('false');
    expect(frameOf('wiki').getAttribute('aria-hidden')).toBe('true');
  });

  it('关闭页签后重新打开，状态归零', async () => {
    renderShell('/wiki');
    const input = screen.getByLabelText('wiki-input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'typed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('typed');

    // 先切走，再关闭 wiki 页签
    await act(async () => {
      screen.getByText('go-code').click();
    });
    await act(async () => {
      screen.getByText('close-wiki').click();
    });
    // 重新打开
    await act(async () => {
      screen.getByText('go-wiki').click();
    });

    expect((screen.getByLabelText('wiki-input') as HTMLInputElement).value).toBe('');
  });

  it('/guide 独立页不进页签帧，也不影响既有帧', async () => {
    renderShell('/wiki');
    await act(async () => {
      screen.getByText('go-guide').click();
    });

    expect(screen.getByText('guide content')).toBeInTheDocument();
    // 独立页只有一个 main，且是激活态
    const frames = document.querySelectorAll('main');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('data-frame-active')).toBe('true');

    // 从 guide 返回 wiki，原帧仍在
    await act(async () => {
      screen.getByText('go-wiki').click();
    });
    expect(screen.getByLabelText('wiki-input')).toBeInTheDocument();
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
