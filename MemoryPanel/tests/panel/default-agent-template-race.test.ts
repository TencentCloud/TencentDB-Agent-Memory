import { createRequire } from 'node:module';
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

interface TeamSummary {
  team_id: string;
  name: string;
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

type ReactDomModule = {
  flushSync: (cb: () => void) => void;
};

type ReactDomClientModule = {
  createRoot: (container: Element) => {
    render: (el: unknown) => void;
    unmount: () => void;
  };
};

type JsdomInstance = {
  window: Window & typeof globalThis & { close: () => void };
};

type JsdomConstructor = new (html: string, opts?: Record<string, unknown>) => JsdomInstance;

type SectionProps = { teamId: string; teamName: string };
type DialogProps = {
  team: TeamSummary;
  initial: TemplateConfig | null;
  onClose: () => void;
  onSaved: (tpl: TemplateConfig) => void;
};
type PanelProps = {
  currentUser: string;
  instanceId: string;
  isAdmin: boolean;
  section?: 'members' | 'agents' | 'all';
};

let React: ReactModule;
let ReactDOM: ReactDomModule;
let ReactDOMClient: ReactDomClientModule;
let JSDOM: JsdomConstructor;
let DefaultAgentTemplateSection: (props: SectionProps) => unknown;
let DefaultAgentTemplateDialog: (props: DialogProps) => unknown;
let TeamManagementPanel: (props: PanelProps) => unknown;

const getDefaultTemplateMock = vi.fn<(teamId: string) => Promise<TemplateConfig>>();
const setDefaultTemplateMock = vi.fn<(teamId: string, tpl: TemplateConfig) => Promise<{ ok: boolean }>>();
const notifyErrorMock = vi.fn<(msg: unknown) => void>();
const notifySuccessMock = vi.fn<(msg: string) => void>();

let currentActiveTeam: TeamSummary | null = null;
let currentTeamsLoading = false;

const GLOBAL_KEYS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'Node',
  'Event',
  'MouseEvent',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

function loadRealComponents() {
  const viteRequire = createRequire(webRequire.resolve('vite'));
  const esbuild = viteRequire('esbuild') as {
    buildSync: (opts: Record<string, unknown>) => { outputFiles: Array<{ text: string }> };
  };
  React = webRequire('react') as ReactModule;
  ReactDOM = webRequire('react-dom') as ReactDomModule;
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
    let loadingAttr = 'false';
    if (props.loading) {
      loadingAttr = 'true';
    }
    return React.createElement(
      'button',
      {
        type: 'button',
        disabled: Boolean(props.disabled),
        'data-loading': loadingAttr,
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

  function ModalStub(props: {
    caption?: string;
    visible?: boolean;
    disableCloseIcon?: boolean;
    onClose?: () => void;
    children?: unknown;
  }) {
    if (!props.visible) return null;
    let closeBtn: unknown = null;
    if (!props.disableCloseIcon) {
      closeBtn = React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': 'close',
          onClick: props.onClose,
        },
        '×',
      );
    }
    return React.createElement(
      'div',
      { role: 'dialog', 'data-testid': 'default-agent-dialog' },
      React.createElement(
        'div',
        { className: 'dialog-header' },
        React.createElement('div', { className: 'dialog-caption' }, props.caption),
        closeBtn,
      ),
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
      UsergroupIcon: IconStub,
    },
    '@/lib/teamApi': {
      teamsApi: { create: vi.fn() },
      skillApi: { forkToAgent: vi.fn() },
      agentsApi: {
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        getDefaultTemplate: (teamId: string) => getDefaultTemplateMock(teamId),
        setDefaultTemplate: (teamId: string, tpl: TemplateConfig) =>
          setDefaultTemplateMock(teamId, tpl),
      },
    },
    '@/lib/api/knowledge-api': {
      knowledgeApi: {
        code: { allocate: vi.fn() },
        wiki: { allocate: vi.fn() },
      },
    },
    '@/services/user-profile-store': {
      useDisplayNameResolver: () => (id: string) => id,
    },
    '@/lib/tea-bridge': {
      tea: {
        confirm: vi.fn(),
        notify: {
          error: (msg: unknown) => notifyErrorMock(msg),
          success: (msg: string) => notifySuccessMock(msg),
        },
      },
    },
    '@/lib/error-message': {
      getErrorMessage: (err: unknown) => {
        if (err instanceof Error) return err.message;
        return String(err);
      },
    },
    '@/services': {
      useTeams: () => {
        let activeTeamId: string | null = null;
        if (currentActiveTeam) {
          activeTeamId = currentActiveTeam.team_id;
        }
        return {
          activeTeamId,
          activeTeam: currentActiveTeam,
          loading: currentTeamsLoading,
        };
      },
      useAgents: () => ({ agents: [], loading: false }),
      isTeamAdmin: () => true,
      canManageAsset: () => true,
      invalidateBackendCache: vi.fn(),
      writeAgentUiMeta: (_base: unknown, ui: Record<string, unknown>) => JSON.stringify({ ui }),
    },
    './team-management-panel.css': {},
    './types': {
      MAX_IMPORTED_CHAT_MEMORIES: 5,
      importedChatMemoryIds: () => [],
    },
    './useAgentAssets': {
      useTeamAssets: () => ({ loading: false, skills: [], codeGraphs: [], wikis: [], chatMemories: [] }),
      useAgentMountedCounts: () => ({ counts: {}, countsLoading: false }),
      syncChatMemoryBindings: vi.fn(),
    },
    './shared': {
      LightField: (props: { label: string; children?: unknown }) =>
        React.createElement('label', null, props.label, props.children),
      CollapseGroup: (props: { title: string; children?: unknown }) =>
        React.createElement('div', null, props.title, props.children),
      AssetCheckList: () => null,
      selectableAssetKeys: () => [],
    },
    './AgentGrid': () => null,
    './TeamHeaderCard': {
      TeamHeaderCard: (props: { team: TeamSummary }) =>
        React.createElement('div', { 'data-testid': 'team-header' }, props.team.name),
    },
    './MemberSection': {
      MemberSection: () => null,
      AddMemberDialog: () => null,
      CreatedUserKeyModal: () => null,
    },
    './CreateTeamDialog': () => null,
    './CreateAgentDialog': () => null,
    './AgentEditDialog': () => null,
    './SessionDefaultSection': () => null,
  };

  const entrySource = `
    export { default as DefaultAgentTemplateSection } from './components/team/DefaultAgentTemplateSection.tsx';
    export { default as DefaultAgentTemplateDialog } from './components/team/DefaultAgentTemplateDialog.tsx';
    export { default as TeamManagementPanel } from './components/team/TeamManagementPanel.tsx';
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
  TeamManagementPanel = moduleObj.exports.TeamManagementPanel as typeof TeamManagementPanel;
}

describe('DefaultAgentTemplateSection E2E race-condition & lifecycle guards', () => {
  let dom: JsdomInstance;
  let container: HTMLDivElement;
  let root: ReturnType<ReactDomClientModule['createRoot']>;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  beforeAll(() => {
    loadRealComponents();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    currentActiveTeam = null;
    currentTeamsLoading = false;
    savedGlobals = new Map();
    for (const key of GLOBAL_KEYS) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }

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
    dom.window.close();
    for (const key of GLOBAL_KEYS) {
      const descriptor = savedGlobals.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
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

  async function drainMicrotasksRaw() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));

    await React.act(async () => {
      reqB.resolve({ name: 'Team B Default', description: 'Desc for Team B' });
      await reqB.promise;
    });

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Default');
    expect(container.querySelector('._memory-default-agent-detail')?.textContent).toBe('Desc for Team B');
    const actionBtnAfterB = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(actionBtnAfterB.disabled).toBe(false);

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
    getDefaultTemplateMock.mockImplementation((teamId) => {
      if (teamId === 'team-a') return reqA.promise;
      return reqB.promise;
    });

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
    getDefaultTemplateMock.mockImplementation((teamId) => {
      if (teamId === 'team-a') return reqA.promise;
      return reqB.promise;
    });

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await React.act(async () => {
      reqA.resolve({ name: 'Team A Template', description: 'Desc A' });
      await reqA.promise;
    });

    const editBtnA = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(editBtnA.disabled).toBe(false);
    await React.act(async () => {
      editBtnA.click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).not.toBeNull();

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));

    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();
    expect(container.querySelector('._memory-default-agent-name')).toBeNull();
    expect(container.textContent).not.toContain('Team A Template');
    expect(container.textContent).toContain('team.loading');

    const btnDuringLoadingB = container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;
    expect(btnDuringLoadingB.disabled).toBe(true);

    await React.act(async () => {
      btnDuringLoadingB.click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();

    await React.act(async () => {
      reqB.resolve({} as TemplateConfig);
      await reqB.promise;
    });
    expect(container.textContent).toContain('defaultAgent.empty');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('4) Commit-phase unmount window: settling load/save right after flushSync unmount suppresses all notifications & callbacks', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Disable act warning only around intentional raw flushSync unmounts (testing pre-passive-effect window)
      const loadReject = createDeferred<TemplateConfig>();
      getDefaultTemplateMock.mockReturnValueOnce(loadReject.promise);

      await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-u1', teamName: 'Team U1' }));
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
      ReactDOM.flushSync(() => {
        root.unmount();
      });
      loadReject.reject(new Error('COMMIT_WINDOW_LOAD_FAIL'));
      await drainMicrotasksRaw();
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      expect(notifyErrorMock).not.toHaveBeenCalled();

      // Save resolve settled immediately after synchronous unmount commit
      root = ReactDOMClient.createRoot(container);
      const saveResolve = createDeferred<{ ok: boolean }>();
      setDefaultTemplateMock.mockReturnValueOnce(saveResolve.promise);
      const onSavedResolveSpy = vi.fn();

      await render(
        React.createElement(DefaultAgentTemplateDialog, {
          team: { team_id: 'team-u2', name: 'Team U2' },
          initial: { name: 'U2 Template', description: 'Desc U2' },
          onClose: vi.fn(),
          onSaved: onSavedResolveSpy,
        }),
      );
      await React.act(async () => {
        (container.querySelector('.dialog-footer button') as HTMLButtonElement).click();
      });

      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
      ReactDOM.flushSync(() => {
        root.unmount();
      });
      saveResolve.resolve({ ok: true });
      await drainMicrotasksRaw();
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      expect(onSavedResolveSpy).not.toHaveBeenCalled();
      expect(notifySuccessMock).not.toHaveBeenCalled();

      // Save rejection settled immediately after synchronous unmount commit
      root = ReactDOMClient.createRoot(container);
      const saveReject = createDeferred<{ ok: boolean }>();
      setDefaultTemplateMock.mockReturnValueOnce(saveReject.promise);
      const onSavedRejectSpy = vi.fn();

      await render(
        React.createElement(DefaultAgentTemplateDialog, {
          team: { team_id: 'team-u3', name: 'Team U3' },
          initial: { name: 'U3 Template', description: 'Desc U3' },
          onClose: vi.fn(),
          onSaved: onSavedRejectSpy,
        }),
      );
      await React.act(async () => {
        (container.querySelector('.dialog-footer button') as HTMLButtonElement).click();
      });

      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
      ReactDOM.flushSync(() => {
        root.unmount();
      });
      saveReject.reject(new Error('COMMIT_WINDOW_SAVE_FAIL'));
      await drainMicrotasksRaw();
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      expect(onSavedRejectSpy).not.toHaveBeenCalled();
      expect(notifyErrorMock).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
      consoleErrorSpy.mockRestore();
      root = ReactDOMClient.createRoot(container);
    }
  });

  it('5) Modal close is blocked while saving, and completes cleanly with onSaved & success toast', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const saveA = createDeferred<{ ok: boolean }>();
    getDefaultTemplateMock.mockReturnValueOnce(reqA.promise);
    setDefaultTemplateMock.mockReturnValueOnce(saveA.promise);

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await React.act(async () => {
      reqA.resolve({ name: 'Initial A', description: 'Initial desc' });
      await reqA.promise;
    });

    await React.act(async () => {
      (container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).click();
    });

    expect(container.querySelector('button[aria-label="close"]')).not.toBeNull();
    const footerBtnsBefore = container.querySelectorAll('.dialog-footer button');
    const saveBtn = footerBtnsBefore[0] as HTMLButtonElement;
    const cancelBtn = footerBtnsBefore[1] as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);

    await React.act(async () => {
      saveBtn.click();
    });

    // While busy: close icon button is hidden and cancel button is disabled
    expect(container.querySelector('button[aria-label="close"]')).toBeNull();
    expect(cancelBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).not.toBeNull();

    await React.act(async () => {
      cancelBtn.click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).not.toBeNull();

    await React.act(async () => {
      saveA.resolve({ ok: true });
      await saveA.promise;
    });
    await flushMicrotasks();

    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Initial A');
    expect(notifySuccessMock).toHaveBeenCalledTimes(1);
    expect(notifySuccessMock).toHaveBeenCalledWith('defaultAgent.notify.saved');
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it('6) Dialog async save race across team switch & empty teamId guard', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    const saveA = createDeferred<{ ok: boolean }>();

    getDefaultTemplateMock.mockImplementation((teamId) => {
      if (teamId === 'team-a') return reqA.promise;
      return reqB.promise;
    });
    setDefaultTemplateMock.mockReturnValueOnce(saveA.promise);

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-a', teamName: 'Team A' }));
    await React.act(async () => {
      reqA.resolve({ name: 'Old A', description: 'Old desc A' });
      await reqA.promise;
    });

    await React.act(async () => {
      (container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).click();
    });
    await React.act(async () => {
      (container.querySelector('.dialog-footer button') as HTMLButtonElement).click();
    });
    expect(setDefaultTemplateMock).toHaveBeenCalledTimes(1);
    expect(setDefaultTemplateMock.mock.calls[0]?.[0]).toBe('team-a');

    await render(React.createElement(DefaultAgentTemplateSection, { teamId: 'team-b', teamName: 'Team B' }));
    await React.act(async () => {
      reqB.resolve({ name: 'Team B Clean', description: 'Clean B' });
      await reqB.promise;
    });

    await React.act(async () => {
      saveA.resolve({ ok: true });
      await saveA.promise;
    });
    await flushMicrotasks();

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Clean');
    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();

    // Empty teamId renders empty state immediately without triggering API request
    getDefaultTemplateMock.mockClear();
    await render(React.createElement(DefaultAgentTemplateSection, { teamId: '', teamName: '' }));
    expect(getDefaultTemplateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('defaultAgent.empty');
    expect((container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('7) Real TeamManagementPanel DOM integration: switching activeTeam remounts section, unmounts old dialog, and isolates stale requests', async () => {
    const reqA = createDeferred<TemplateConfig>();
    const reqB = createDeferred<TemplateConfig>();
    const saveA = createDeferred<{ ok: boolean }>();

    getDefaultTemplateMock.mockImplementation((teamId) => {
      if (teamId === 'team-a') return reqA.promise;
      if (teamId === 'team-b') return reqB.promise;
      throw new Error(`unexpected team ${teamId}`);
    });
    setDefaultTemplateMock.mockReturnValueOnce(saveA.promise);

    currentActiveTeam = { team_id: 'team-a', name: 'Team Alpha' };
    await render(
      React.createElement(TeamManagementPanel, {
        currentUser: 'admin',
        instanceId: 'inst-1',
        isAdmin: true,
        section: 'agents',
      }),
    );

    const sectionNodeA = container.querySelector('._memory-default-agent-section');
    expect(sectionNodeA).not.toBeNull();
    expect(container.querySelector('[data-testid="team-header"]')?.textContent).toBe('Team Alpha');

    await React.act(async () => {
      reqA.resolve({ name: 'Alpha Template', description: 'Alpha desc' });
      await reqA.promise;
    });
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Alpha Template');

    // Open dialog and start saving on Team Alpha
    await React.act(async () => {
      (container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).not.toBeNull();

    await React.act(async () => {
      (container.querySelector('.dialog-footer button') as HTMLButtonElement).click();
    });
    expect(setDefaultTemplateMock).toHaveBeenCalledTimes(1);

    // Switch activeTeam to Team Beta in real TeamManagementPanel
    currentActiveTeam = { team_id: 'team-b', name: 'Team Beta' };
    await render(
      React.createElement(TeamManagementPanel, {
        currentUser: 'admin',
        instanceId: 'inst-1',
        isAdmin: true,
        section: 'agents',
      }),
    );

    // Keyed remount produces a brand-new DOM node and automatically unmounts Team Alpha's dialog
    const sectionNodeB = container.querySelector('._memory-default-agent-section');
    expect(sectionNodeB).not.toBeNull();
    expect(sectionNodeB).not.toBe(sectionNodeA);
    expect(container.querySelector('[data-testid="default-agent-dialog"]')).toBeNull();
    expect(container.textContent).toContain('team.loading');

    // Late Team Alpha save settles while Team Beta is active — must not overwrite or notify
    await React.act(async () => {
      saveA.resolve({ ok: true });
      await saveA.promise;
    });
    await flushMicrotasks();

    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();

    // Team Beta load resolves cleanly
    await React.act(async () => {
      reqB.resolve({ name: 'Beta Template', description: 'Beta desc' });
      await reqB.promise;
    });

    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Beta Template');
    expect(container.querySelector('._memory-default-agent-detail')?.textContent).toBe('Beta desc');
    expect(container.textContent).not.toContain('Alpha Template');
  });
});
