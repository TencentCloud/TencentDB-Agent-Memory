import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTemplateConfig } from '../../web/src/lib/api/agents';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const React = requireWeb('react') as typeof import('react');
const { createRoot } = requireWeb('react-dom/client') as typeof import('react-dom/client');
const { JSDOM } = requireWeb('jsdom') as typeof import('jsdom');

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  getDefaultTemplate: vi.fn<(teamId: string) => Promise<AgentTemplateConfig>>(),
  setDefaultTemplate: vi.fn<(teamId: string, tpl: AgentTemplateConfig) => Promise<{ ok: boolean }>>(),
  notifyError: vi.fn<(msg: unknown) => void>(),
  notifySuccess: vi.fn<(msg: string) => void>(),
}));

vi.mock('@/lib/teamApi', () => ({
  agentsApi: {
    getDefaultTemplate: (teamId: string) => mocks.getDefaultTemplate(teamId),
    setDefaultTemplate: (teamId: string, tpl: AgentTemplateConfig) => mocks.setDefaultTemplate(teamId, tpl),
  },
}));
vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify: { error: mocks.notifyError, success: mocks.notifySuccess } },
}));
vi.mock('@/lib/error-message', () => ({
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('@/services', () => ({
  writeAgentUiMeta: (_base: unknown, ui: Record<string, unknown>) => JSON.stringify({ ui }),
}));
vi.mock('../../web/src/components/team/useAgentAssets', () => ({
  useTeamAssets: () => ({ loading: false, skills: [], codeGraphs: [], wikis: [], chatMemories: [] }),
}));
vi.mock('../../web/src/components/team/shared', () => ({
  LightField: (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children),
  CollapseGroup: (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children),
  AssetCheckList: () => null,
  selectableAssetKeys: () => [],
}));

const resolvePkgEntries = (pkg: string) => {
  const pkgJsonPath = requireWeb.resolve(`${pkg}/package.json`);
  const pkgJson = requireWeb(`${pkg}/package.json`) as { module?: string; main?: string };
  const dir = dirname(pkgJsonPath);
  return [...new Set([pkgJson.module, pkgJson.main].filter(Boolean).map((p) => resolve(dir, p!)))];
};

for (const entry of resolvePkgEntries('react-i18next')) {
  vi.doMock(entry, () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
}
for (const entry of resolvePkgEntries('tea-icons-react')) {
  vi.doMock(entry, () => {
    const icon = () => null;
    return { AddIcon: icon, EditIcon: icon, BooksIcon: icon, CodeIcon: icon, ToolsIcon: icon };
  });
}
const teaComponentMock = () => {
  const Button = (p: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }) =>
    React.createElement('button', { type: 'button', disabled: Boolean(p.disabled), onClick: p.onClick }, p.children);
  const Input = Object.assign(
    (p: { value?: string; onChange?: (v: string) => void }) =>
      React.createElement('input', { value: p.value ?? '', onChange: (e: { target: { value: string } }) => p.onChange?.(e.target.value) }),
    {
      TextArea: (p: { value?: string; onChange?: (v: string) => void }) =>
        React.createElement('textarea', { value: p.value ?? '', onChange: (e: { target: { value: string } }) => p.onChange?.(e.target.value) }),
    },
  );
  const Modal = Object.assign(
    (p: { visible?: boolean; disableCloseIcon?: boolean; onClose?: () => void; children?: React.ReactNode }) => {
      if (!p.visible) return null;
      return React.createElement(
        'div',
        { role: 'dialog' },
        !p.disableCloseIcon && React.createElement('button', { type: 'button', 'aria-label': 'close', onClick: p.onClose }),
        p.children,
      );
    },
    {
      Body: (p: { children?: React.ReactNode }) => React.createElement('div', null, p.children),
      Footer: (p: { children?: React.ReactNode }) => React.createElement('div', { className: 'dialog-footer' }, p.children),
    },
  );
  return { Button, Input, Modal, Tag: (p: { children?: React.ReactNode }) => React.createElement('span', null, p.children) };
};
for (const entry of resolvePkgEntries('tea-component')) {
  vi.doMock(entry, teaComponentMock);
}

const { default: DefaultAgentTemplateSection } = await import(
  '../../web/src/components/team/DefaultAgentTemplateSection'
);

const GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const;

describe('DefaultAgentTemplateSection race-condition & lifecycle guards', () => {
  let dom: InstanceType<typeof JSDOM>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  beforeEach(() => {
    vi.resetAllMocks();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    savedGlobals = new Map(GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [k, desc] of savedGlobals) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  });

  const renderSection = (teamId: string, teamName: string) =>
    React.act(async () => root.render(React.createElement(DefaultAgentTemplateSection, { teamId, teamName })));

  const actionButton = () => container.querySelector('._memory-default-agent-actions button') as HTMLButtonElement;

  it('ignores stale Team A resolve and failure after Team B loads', async () => {
    const reqA1 = createDeferred<AgentTemplateConfig>();
    const reqB = createDeferred<AgentTemplateConfig>();
    mocks.getDefaultTemplate.mockImplementation((id) => (id === 'team-a' ? reqA1.promise : reqB.promise));

    await renderSection('team-a', 'Team A');
    expect(actionButton().disabled).toBe(true);

    await renderSection('team-b', 'Team B');
    await React.act(async () => {
      reqB.resolve({ name: 'Team B Template', description: 'Desc B' });
      await reqB.promise;
    });
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Template');
    expect(actionButton().disabled).toBe(false);

    await React.act(async () => {
      reqA1.resolve({ name: 'Stale A', description: 'Desc A' });
      await reqA1.promise;
    });
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Template');

    // Stale failure on Team A must not clear Team B or toast an error
    const reqA2 = createDeferred<AgentTemplateConfig>();
    const reqB2 = createDeferred<AgentTemplateConfig>();
    mocks.getDefaultTemplate.mockImplementation((id) => (id === 'team-a' ? reqA2.promise : reqB2.promise));
    await renderSection('team-a', 'Team A');
    await renderSection('team-b', 'Team B');
    await React.act(async () => {
      reqB2.resolve({ name: 'Team B Stable', description: 'Stable' });
      await reqB2.promise;
    });
    await React.act(async () => {
      reqA2.reject(new Error('TEAM_A_FAILED'));
      await Promise.resolve();
    });
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Stable');
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it('clears dialog and disables edit across A->B->A switches', async () => {
    const reqA1 = createDeferred<AgentTemplateConfig>();
    const reqB = createDeferred<AgentTemplateConfig>();
    const reqA2 = createDeferred<AgentTemplateConfig>();
    let aCalls = 0;
    mocks.getDefaultTemplate.mockImplementation((id) => {
      if (id === 'team-b') return reqB.promise;
      aCalls += 1;
      return aCalls === 1 ? reqA1.promise : reqA2.promise;
    });

    await renderSection('team-a', 'Team A');
    await React.act(async () => {
      reqA1.resolve({ name: 'Team A Template', description: 'Desc A' });
      await reqA1.promise;
    });
    await React.act(async () => actionButton().click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await renderSection('team-b', 'Team B');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('Team A Template');
    expect(actionButton().disabled).toBe(true);

    // Switch back to Team A before B finishes — stays loading and dialog does not reopen
    await renderSection('team-a', 'Team A');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(actionButton().disabled).toBe(true);
    await React.act(async () => {
      reqA2.resolve({ name: 'Team A Fresh', description: 'Fresh' });
      await reqA2.promise;
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team A Fresh');
  });

  it('locks modal close during save and ignores late save or load after unmount / team switch', async () => {
    const reqA = createDeferred<AgentTemplateConfig>();
    const reqB = createDeferred<AgentTemplateConfig>();
    const saveA = createDeferred<{ ok: boolean }>();
    mocks.getDefaultTemplate.mockImplementation((id) => (id === 'team-a' ? reqA.promise : reqB.promise));
    mocks.setDefaultTemplate.mockReturnValueOnce(saveA.promise);

    await renderSection('team-a', 'Team A');
    await React.act(async () => {
      reqA.resolve({ name: 'Team A Editable', description: 'Desc' });
      await reqA.promise;
    });
    await React.act(async () => actionButton().click());
    expect(container.querySelector('[aria-label="close"]')).not.toBeNull();

    const saveBtn = container.querySelector('.dialog-footer button') as HTMLButtonElement;
    await React.act(async () => saveBtn.click());
    expect(container.querySelector('[aria-label="close"]')).toBeNull();

    // Switch team mid-save -> dialog unmounts, late save must not overwrite Team B or toast
    await renderSection('team-b', 'Team B');
    await React.act(async () => {
      reqB.resolve({ name: 'Team B Clean', description: 'Clean' });
      await reqB.promise;
    });
    await React.act(async () => {
      saveA.resolve({ ok: true });
      await saveA.promise;
    });
    expect(container.querySelector('._memory-default-agent-name')?.textContent).toBe('Team B Clean');
    expect(mocks.notifySuccess).not.toHaveBeenCalled();

    // Unmount with pending request -> late reject produces no error toast
    const reqC = createDeferred<AgentTemplateConfig>();
    mocks.getDefaultTemplate.mockReturnValueOnce(reqC.promise);
    await renderSection('team-c', 'Team C');
    await React.act(async () => root.unmount());
    await React.act(async () => {
      reqC.reject(new Error('LATE_UNMOUNT_ERR'));
      await Promise.resolve();
    });
    expect(mocks.notifyError).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
