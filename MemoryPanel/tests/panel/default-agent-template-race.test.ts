import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, '../../web');
const WEB_SRC = path.join(WEB_DIR, 'src');
const webRequire = createRequire(path.join(WEB_DIR, 'package.json'));

interface TemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  metadata_json?: string;
  asset_ids?: { skills?: string[]; code_graphs?: string[]; wikis?: string[] };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ReactModule = {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  act: (cb: () => void | Promise<void>) => Promise<void>;
};

type ReactDomClientModule = {
  createRoot: (container: Element) => {
    render: (el: unknown) => void;
    unmount: () => void;
  };
};

type JsdomConstructor = new (html: string, opts?: Record<string, unknown>) => {
  window: Window & typeof globalThis;
};

type SectionProps = { teamId: string; teamName: string };
type DialogProps = {
  team: { team_id: string; name: string };
  initial: TemplateConfig | null;
  onClose: () => void;
  onSaved: (tpl: TemplateConfig) => void;
};

let React: ReactModule;
let ReactDOMClient: ReactDomClientModule;
let JSDOM: JsdomConstructor;
let DefaultAgentTemplateSection: (props: SectionProps) => unknown;
let DefaultAgentTemplateDialog: (props: DialogProps) => unknown;

const getDefaultTemplateMock = vi.fn<(teamId: string) => Promise<TemplateConfig>>();
const setDefaultTemplateMock = vi.fn<(teamId: string, tpl: TemplateConfig) => Promise<{ ok: boolean }>>();
const notifyErrorMock = vi.fn<(msg: unknown) => void>();
const notifySuccessMock = vi.fn<(msg: string) => void>();

// 最小测试替身：将外部 UI 库与 API 绑定到可观测 spy，保留被测 TSX 组件真实逻辑
function loadRealComponents() {
  const esbuild = webRequire('esbuild') as {
    buildSync: (opts: Record<string, unknown>) => { outputFiles: Array<{ text: string }> };
  };
  React = webRequire('react') as ReactModule;
  ReactDOMClient = webRequire('react-dom/client') as ReactDomClientModule;
  const jsxRuntime = webRequire('react/jsx-runtime');
  JSDOM = (webRequire('jsdom') as { JSDOM: JsdomConstructor }).JSDOM;

  function ButtonStub(props: {
    children?: unknown;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
    title?: string;
    type?: string;
  }) {
    return React.createElement(
      'button',
      {
        type: 'button',
        disabled: Boolean(props.disabled),
        'data-loading': props.loading ? 'true' : 'false',
        title: props.title,
        onClick: props.onClick,
      },
      props.children,
    );
  }

  function InputStub(props: {
    value?: string;
    onChange?: (val: string) => void;
    placeholder?: string;
  }) {
    return React.createElement('input', {
      value: props.value ?? '',
      placeholder: props.placeholder,
      onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
    });
  }
  (InputStub as unknown as Record<string, unknown>).TextArea = function TextAreaStub(props: {
    value?: string;
    onChange?: (val: string) => void;
    placeholder?: string;
  }) {
    return React.createElement('textarea', {
      value: props.value ?? '',
      placeholder: props.placeholder,
      onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
    });
  };

  function ModalStub(props: { caption?: string; visible?: boolean; children?: unknown }) {
    if (!props.visible) return null;
    return React.createElement(
      'div',
      { role: 'dialog', 'data-testid': 'default-agent-dialog' },
      React.createElement('div', { className: 'dialog-caption' }, props.caption),
      props.children,
    );
  }
  (ModalStub as unknown as Record<string, unknown>).Body = (props: { children?: unknown }) =>
    React.createElement('div', { className: 'dialog-body' }, props.children);
  (ModalStub as unknown as Record<string, unknown>).Footer = (props: { children?: unknown }) =>
    React.createElement('div', { className: 'dialog-footer' }, props.children);

  function TagStub(props: { children?: unknown }) {
    return React.createElement('span', { className: 'tag' }, props.children);
  }

  function IconStub() {
    return React.createElement('span', { 'aria-hidden': 'true' });
  }

  const stubs: Record<string, unknown> = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react-i18next': {
      useTranslation: () => ({ t: (key: string) => key }),
    },
    'tea-component': {
      Button: ButtonStub,
      Input: InputStub,
      Modal: ModalStub,
      Tag: TagStub,
      Checkbox: () => null,
    },
    'tea-icons-react': {
      AddIcon: IconStub,
      EditIcon: IconStub,
      BooksIcon: IconStub,
      CodeIcon: IconStub,
      ToolsIcon: IconStub,
      ChevronRightIcon: IconStub,
    },
    '@/lib/teamApi': {
      agentsApi: {
        getDefaultTemplate: (teamId: string) => getDefaultTemplateMock(teamId),
        setDefaultTemplate: (teamId: string, tpl: TemplateConfig) =>
          setDefaultTemplateMock(teamId, tpl),
      },
    },
    '@/lib/tea-bridge': {
      tea: {
        notify: {
          error: (msg: unknown) => notifyErrorMock(msg),
          success: (msg: string) => notifySuccessMock(msg),
        },
      },
    },
    '@/lib/error-message': {
      getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    },
    '@/services': {
      writeAgentUiMeta: (_base: unknown, ui: Record<string, unknown>) => JSON.stringify({ ui }),
    },
    './useAgentAssets': {
      useTeamAssets: () => ({ loading: false, skills: [], codeGraphs: [], wikis: [], chatMemories: [] }),
    },
    './shared': {
      LightField: (props: { label: string; children?: unknown }) =>
        React.createElement('label', null, props.label, props.children),
      CollapseGroup: (props: { title: string; children?: unknown }) =>
        React.createElement('div', null, props.title, props.children),
      AssetCheckList: () => null,
      selectableAssetKeys: () => [],
    },
  };

  const entrySource = `
    export { default as DefaultAgentTemplateSection } from './components/team/DefaultAgentTemplateSection.tsx';
    export { default as DefaultAgentTemplateDialog } from './components/team/DefaultAgentTemplateDialog.tsx';
  `;

  const built = esbuild.buildSync({
    stdin: {
      contents: entrySource,
      resolveDir: WEB_SRC,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    jsx: 'automatic',
    platform: 'node',
    target: 'es2022',
    external: Object.keys(stubs),
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const customRequire = (id: string) => {
    if (id in stubs) return stubs[id];
    return webRequire(id);
  };
  const fn = new Function('require', 'module', 'exports', built.outputFiles[0]!.text);
  fn(customRequire, moduleObj, moduleObj.exports);

  DefaultAgentTemplateSection = moduleObj.exports.DefaultAgentTemplateSection as typeof DefaultAgentTemplateSection;
  DefaultAgentTemplateDialog = moduleObj.exports.DefaultAgentTemplateDialog as typeof DefaultAgentTemplateDialog;
}

describe('DefaultAgentTemplateSection E2E race-condition & lifecycle guards', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: ReturnType<ReactDomClientModule['createRoot']>;

  beforeAll(() => {
    loadRealComponents();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const win = dom.window;
    Object.assign(globalThis, {
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement,
      HTMLInputElement: win.HTMLInputElement,
      Node: win.Node,
      Event: win.Event,
      MouseEvent: win.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = win.document.getElementById('root') as HTMLDivElement;
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(element: unknown) {
    await React.act(async () => {
      root.render(element);
    });
  }

  async function flushMicrotasks() {
    await React.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('1) A->B out-of-order resolve: Team B stays displayed when stale Team A resolves later', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    getDefaultTemplateMock.mockImplementation((teamId) => {
      if (teamId === 'team-a') return reqA.promise;
      if (teamId === 'team-b') return reqB.promise;
      throw new Error(`unexpected team ${teamId}`);
    });

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    const actionBtnWhileA = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(actionBtnWhileA.disabled).toBe(true);

    // Switch to Team B before Team A resolves (reusing same component instance)
    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));

    // Team B resolves first
    await React.act(async () => {
      reqB.resolve({ name: 'Team B Default', description: 'Desc for Team B' });
      await reqB.promise;
    });

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Default');
    expect(container.querySelector('._memory-default-agent-detail')?.textContent).toBe('Desc for Team B');
    const actionBtnAfterB = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(actionBtnAfterB.disabled).toBe(false);

    // Stale Team A resolves later — must be silently ignored
    await React.act(async () => {
      reqA.resolve({ name: 'Team A Default', description: 'Stale Desc A' });
      await reqA.promise;
    });

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Default');
    expect(container.querySelector('._memory-default-agent-detail')?.textContent).toBe('Desc for Team B');
    expect(container.textContent).not.toContain('Team A Default');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it('2) Stale Team A rejection after Team B resolves keeps Team B intact with no error toast', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    getDefaultTemplateMock.mockImplementation((teamId) => (teamId === 'team-a' ? reqA.promise : reqB.promise));

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));

    await React.act(async () => {
      reqB.resolve({ name: 'Team B Stable', description: 'Stable B desc' });
      await reqB.promise;
    });

    await React.act(async () => {
      reqA.reject(new Error('TEAM_A_NETWORK_TIMEOUT'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Stable');
    expect(container.querySelector('._memory-default-agent-detail')?.textContent).toBe('Stable B desc');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it('3) Switching teams closes open dialog, clears old template, and disables edit while loading', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    getDefaultTemplateMock.mockImplementation((teamId) => (teamId === 'team-a' ? reqA.promise : reqB.promise));

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await React.act(async () => {
      reqA.resolve({ name: 'Team A Template', description: 'Desc A' });
      await reqA.promise;
    });

    // Open edit dialog for Team A
    const editBtnA = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(editBtnA.disabled).toBe(false);
    await React.act(async () => {
      editBtnA.click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).not.toBeNull();

    // Switch to Team B: dialog must close, old template must be cleared, button must be disabled during loading
    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));

    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();
    expect(container.querySelector('._memory-default-agent-name')).toBeNull();
    expect(container.textContent).not.toContain('Team A Template');
    expect(container.textContent).toContain('team.loading');

    const btnDuringLoadingB = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(btnDuringLoadingB.disabled).toBe(true);

    // Attempting to click while loading must not open the dialog
    await React.act(async () => {
      btnDuringLoadingB.click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();

    // Finish Team B loading (empty team)
    await React.act(async () => {
      reqB.resolve({} as TemplateConfig);
      await reqB.promise;
    });
    expect(container.textContent).toContain('defaultAgent.empty');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('4) Unmount before pending request settles: resolve and reject cause no errors or notifications', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reqResolve = createDeferred<TemplateConfig>();
      getDefaultTemplateMock.mockReturnValueOnce(reqResolve.promise);

      await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-x', teamName: 'Team X' }));
      await React.act(async () => {
        root.unmount();
      });

      await React.act(async () => {
        reqResolve.resolve({ name: 'Late Resolve', description: 'Should not mount' });
        await reqResolve.promise;
      });
      await flushMicrotasks();

      // Remount fresh root to test late reject after unmount
      root = ReactDOMClient.createRoot(container);
      const reqReject = createDeferred<TemplateConfig>();
      getDefaultTemplateMock.mockReturnValueOnce(reqReject.promise);

      await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-y', teamName: 'Team Y' }));
      await React.act(async () => {
        root.unmount();
      });

      await React.act(async () => {
        reqReject.reject(new Error('LATE_FAILURE_AFTER_UNMOUNT'));
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(notifyErrorMock).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      // Recreate root for afterEach cleanup
      root = ReactDOMClient.createRoot(container);
    }
  });

  it('5) Dialog async save race: unmounting or switching team before save settles ignores late save callback & error', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    const saveA = createDeferred<{ ok: boolean }>();

    getDefaultTemplateMock.mockImplementation((teamId) => (teamId === 'team-a' ? reqA.promise : reqB.promise));
    setDefaultTemplateMock.mockReturnValueOnce(saveA.promise);

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await React.act(async () => {
      reqA.resolve({ name: 'Old A', description: 'Old desc A' });
      await reqA.promise;
    });

    // Open dialog and trigger save on Team A
    await React.act(async () => {
      (container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).click();
    });
    const saveBtn = container.querySelector('.dialog-footer button') as HTMLButtonElement;
    expect(saveBtn).not.toBeNull();
    await React.act(async () => {
      saveBtn.click();
    });
    expect(setDefaultTemplateMock).toHaveBeenCalledTimes(1);
    expect(setDefaultTemplateMock.mock.calls[0]?.[0]).toBe('team-a');

    // Switch to Team B before Team A save resolves — unmounts dialog and loads Team B
    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));
    await React.act(async () => {
      reqB.resolve({ name: 'Team B Clean', description: 'Clean B' });
      await reqB.promise;
    });

    // Team A save resolves late — must NOT overwrite Team B or trigger saved toast
    await React.act(async () => {
      saveA.resolve({ ok: true });
      await saveA.promise;
    });
    await flushMicrotasks();

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Clean');
    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();

    // Direct Dialog unmount-on-reject check: rejecting save after unmount must not call notify.error or onSaved
    const lateRejectSave = createDeferred<{ ok: boolean }>();
    setDefaultTemplateMock.mockReturnValueOnce(lateRejectSave.promise);
    const onSavedSpy = vi.fn();

    await render(
      React.createElement(DefaultAgentTemplateDialog, {
        team: { team_id: 'team-z', name: 'Team Z' },
        initial: { name: 'Z Template', description: 'Desc Z' },
        onClose: vi.fn(),
        onSaved: onSavedSpy,
      }),
    );

    const dialogSaveBtn = container.querySelector('.dialog-footer button') as HTMLButtonElement;
    await React.act(async () => {
      dialogSaveBtn.click();
    });

    await React.act(async () => {
      root.unmount();
    });

    await React.act(async () => {
      lateRejectSave.reject(new Error('SAVE_FAILED_AFTER_UNMOUNT'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(onSavedSpy).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();

    // Recreate root for afterEach
    root = ReactDOMClient.createRoot(container);
  });

  it('6) TeamManagementPanel passes key={activeTeam.team_id} to DefaultAgentTemplateSection and handles empty teamId without stuck loading', async () => {
    const panelSource = readFileSync(
      path.join(WEB_SRC, 'components/team/TeamManagementPanel.tsx'),
      'utf8',
    );
    expect(panelSource).toMatch(
      /<DefaultAgentTemplateSection[\s\S]*?key=\{activeTeam\.team_id\}[\s\S]*?\/>/,
    );

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: '', teamName: '' }));
    expect(getDefaultTemplateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('defaultAgent.empty');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
  });
});
