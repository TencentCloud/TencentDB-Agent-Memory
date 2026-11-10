/**
 * 默认 Agent 模板弹窗的卸载守卫（issue #1935）。
 *
 * 切团队会重挂载 Section，弹窗随之卸载；此时进行中的保存不应再回调
 * onSaved，也不应弹出过期的失败提示。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');

const { setDefaultTemplate, notifyError } = vi.hoisted(() => ({
  setDefaultTemplate: vi.fn(),
  notifyError: vi.fn(),
}));

const stableT = (key: string) => key;

vi.mock('@/lib/teamApi', () => ({
  agentsApi: { setDefaultTemplate, getDefaultTemplate: vi.fn() },
}));
vi.mock('@/services', () => ({ writeAgentUiMeta: () => '{}' }));
vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify: { error: notifyError, success: vi.fn(), info: vi.fn() } },
}));
vi.mock('@/lib/error-message', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../web/src/components/team/shared', () => {
  const container = ({ children }: { children: unknown }) => createElement('div', null, children);
  return {
    LightField: container,
    CollapseGroup: container,
    AssetCheckList: () => null,
    selectableAssetKeys: () => [],
  };
});
vi.mock('../web/src/components/team/useAgentAssets', () => ({
  useTeamAssets: () => ({ loading: false, skills: [], codeGraphs: [], wikis: [] }),
}));
vi.doMock(
  resolve(
    dirname(requireWeb.resolve('react-i18next/package.json')),
    requireWeb('react-i18next/package.json').module,
  ),
  () => ({ useTranslation: () => ({ t: stableT }) }),
);
vi.doMock(requireWeb.resolve('tea-component'), () => {
  const container = ({ children }: { children: unknown }) => createElement('div', null, children);
  return {
    Modal: Object.assign(container, { Body: container, Footer: container }),
    Input: Object.assign(container, { TextArea: container }),
    Tag: container,
    Button: ({ children, disabled, onClick }: {
      children: unknown;
      disabled?: boolean;
      onClick?: () => void;
    }) => createElement('button', { disabled, onClick }, children),
  };
});
vi.doMock(requireWeb.resolve('tea-icons-react'), () => ({
  BooksIcon: () => null,
  CodeIcon: () => null,
  ToolsIcon: () => null,
}));

const { default: DefaultAgentTemplateDialog } = await import(
  '../web/src/components/team/DefaultAgentTemplateDialog'
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

describe('DefaultAgentTemplateDialog 卸载守卫', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  let host: HTMLElement;
  let mounted: boolean;
  const onSaved = vi.fn();

  beforeEach(async () => {
    setDefaultTemplate.mockReset();
    notifyError.mockReset();
    onSaved.mockReset();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;

    await act(async () => {
      root.render(
        createElement(DefaultAgentTemplateDialog, {
          team: { team_id: 'A', name: 'Team A' },
          initial: { name: 'Template A' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
  });

  afterEach(async () => {
    if (mounted) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function clickSave() {
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === 'defaultAgent.save',
    )!;
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  }

  async function unmount() {
    await act(async () => root.unmount());
    mounted = false;
  }

  it('保存进行中卸载后，不再回调 onSaved', async () => {
    const pending = deferred<unknown>();
    setDefaultTemplate.mockReturnValue(pending.promise);

    await clickSave();
    await unmount();

    await act(async () => {
      pending.resolve({});
      await Promise.resolve();
    });

    expect(onSaved).not.toHaveBeenCalled();
  });

  it('保存失败且已卸载时，不再弹失败提示', async () => {
    const pending = deferred<unknown>();
    setDefaultTemplate.mockReturnValue(pending.promise);

    await clickSave();
    await unmount();

    await act(async () => {
      pending.reject(new Error('save failed'));
      await Promise.resolve();
    });

    expect(notifyError).not.toHaveBeenCalled();
  });
});
