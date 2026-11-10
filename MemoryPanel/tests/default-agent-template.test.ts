/**
 * 默认 Agent 模板的团队切换竞态（issue #1935）。
 *
 * 挂载真实的 DefaultAgentTemplateSection，用两个受控 Promise 复现：
 *   - A→B 乱序返回时，最终只显示 B 的模板；
 *   - 旧团队请求失败不清空 B、不向 B 的界面报错；
 *   - 加载中禁用操作按钮；
 *   - 卸载后过期请求不再弹通知。
 *
 * 父包没有 React / jsdom，这里用 createRequire 借用 web 包已有的依赖。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTemplateConfig } from '../web/src/lib/teamApi';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');

const { getDefaultTemplate, notifyError } = vi.hoisted(() => ({
  getDefaultTemplate: vi.fn(),
  notifyError: vi.fn(),
}));

const stableT = (key: string) => key;

vi.mock('@/lib/teamApi', () => ({
  agentsApi: { getDefaultTemplate, setDefaultTemplate: vi.fn() },
}));
vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify: { error: notifyError, success: vi.fn(), info: vi.fn() } },
}));
vi.mock('@/lib/error-message', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// 弹窗不在本次测试范围内，避免拉起它的资产加载依赖
vi.mock('../web/src/components/team/DefaultAgentTemplateDialog', () => ({
  default: () => null,
}));
vi.doMock(
  resolve(
    dirname(requireWeb.resolve('react-i18next/package.json')),
    requireWeb('react-i18next/package.json').module,
  ),
  () => ({ useTranslation: () => ({ t: stableT }) }),
);
vi.doMock(requireWeb.resolve('tea-component'), () => ({
  Button: ({ children, disabled, onClick }: {
    children: unknown;
    disabled?: boolean;
    onClick?: () => void;
  }) => createElement('button', { disabled, onClick }, children),
}));
vi.doMock(requireWeb.resolve('tea-icons-react'), () => ({
  AddIcon: () => null,
  EditIcon: () => null,
}));

const { default: DefaultAgentTemplateSection } = await import(
  '../web/src/components/team/DefaultAgentTemplateSection'
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tpl = (name: string) => ({ name }) as AgentTemplateConfig;

describe('DefaultAgentTemplateSection 团队切换', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  let host: HTMLElement;
  let mounted: boolean;

  beforeEach(async () => {
    getDefaultTemplate.mockReset();
    notifyError.mockReset();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
  });

  afterEach(async () => {
    if (mounted) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderTeam(teamId: string, key?: string) {
    await act(async () => {
      root.render(
        createElement(DefaultAgentTemplateSection, {
          ...(key ? { key } : {}),
          teamId,
          teamName: `Team ${teamId}`,
        }),
      );
    });
  }

  it('A→B 乱序返回时，最终只显示 B 的模板', async () => {
    const a = deferred<AgentTemplateConfig | null>();
    const b = deferred<AgentTemplateConfig | null>();
    getDefaultTemplate.mockImplementation((id: string) => (id === 'A' ? a.promise : b.promise));

    await renderTeam('A');
    await renderTeam('B');

    await act(async () => {
      b.resolve(tpl('Template B'));
      await Promise.resolve();
    });
    await act(async () => {
      a.resolve(tpl('Template A'));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Template B');
    expect(host.textContent).not.toContain('Template A');
  });

  it('旧团队的请求失败时，不清空当前团队，也不弹错', async () => {
    const a = deferred<AgentTemplateConfig | null>();
    const b = deferred<AgentTemplateConfig | null>();
    getDefaultTemplate.mockImplementation((id: string) => (id === 'A' ? a.promise : b.promise));

    await renderTeam('A');
    await renderTeam('B');

    await act(async () => {
      b.resolve(tpl('Template B'));
      await Promise.resolve();
    });
    await act(async () => {
      a.reject(new Error('A failed'));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Template B');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('加载中禁用操作按钮，加载完成后恢复', async () => {
    const a = deferred<AgentTemplateConfig | null>();
    getDefaultTemplate.mockReturnValue(a.promise);

    await renderTeam('A');
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(true);

    await act(async () => {
      a.resolve(tpl('Template A'));
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
  });

  it('卸载后过期请求的失败不再弹通知', async () => {
    const a = deferred<AgentTemplateConfig | null>();
    getDefaultTemplate.mockReturnValue(a.promise);

    await renderTeam('A');
    await act(async () => {
      root.unmount();
    });
    mounted = false;

    await act(async () => {
      a.reject(new Error('late failure'));
      await Promise.resolve();
    });

    expect(notifyError).not.toHaveBeenCalled();
  });
});
