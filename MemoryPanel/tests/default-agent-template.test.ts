import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the web package's React/DOM dependencies; the parent owns Vitest.
const requireWeb = createRequire(
  new URL('../web/package.json', import.meta.url),
);
const { createElement, act, StrictMode } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');

const mocks = vi.hoisted(() => ({
  getDefaultTemplate: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dialog: vi.fn(),
}));

vi.mock('@/lib/teamApi', () => ({ agentsApi: mocks }));
vi.mock('@/lib/tea-bridge', () => ({ tea: { notify: mocks } }));
vi.mock('@/lib/error-message', () => ({
  getErrorMessage: (err: Error) => err.message,
}));
// Vite imports the ESM entry, while require.resolve selects the CommonJS entry.
vi.doMock(
  resolve(
    dirname(requireWeb.resolve('react-i18next/package.json')),
    requireWeb('react-i18next/package.json').module,
  ),
  () => ({
    useTranslation: () => ({ t: (key: string) => key }),
  }),
);
vi.doMock(requireWeb.resolve('tea-icons-react'), () => ({
  AddIcon: () => null,
  EditIcon: () => null,
}));
vi.doMock(requireWeb.resolve('tea-component'), () => ({
  Button: ({ children, type: _type, ...props }: any) =>
    createElement('button', props, children),
}));
vi.mock('../web/src/components/team/DefaultAgentTemplateDialog', () => ({
  default: (props: any) => {
    mocks.dialog(props);
    return createElement(
      'div',
      { 'data-dialog': props.team.team_id },
      props.initial?.name,
    );
  },
}));

const { default: DefaultAgentTemplateSection } =
  await import('../web/src/components/team/DefaultAgentTemplateSection');

function deferred() {
  let resolve!: (value: { name?: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ name?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('default Agent template team switching', () => {
  let dom: any;
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDefaultTemplate.mockReset();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });

  async function render(teamId: string, strict = false) {
    const section = createElement(DefaultAgentTemplateSection, {
      teamId,
      teamName: teamId,
    });
    await act(async () =>
      root.render(strict ? createElement(StrictMode, null, section) : section),
    );
  }

  function action() {
    return container.querySelector('button')!;
  }

  it('keeps B when A resolves after B', async () => {
    const a = deferred();
    const b = deferred();
    mocks.getDefaultTemplate
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    await render('A');
    await render('B');
    await act(async () => b.resolve({ name: 'B template' }));
    await act(async () => a.resolve({ name: 'A template' }));
    expect(container.textContent).toContain('B template');
    expect(container.textContent).not.toContain('A template');
    expect(action().disabled).toBe(false);
  });

  it('ignores an old failure without clearing B or showing its error', async () => {
    const a = deferred();
    const b = deferred();
    mocks.getDefaultTemplate
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    await render('A');
    await render('B');
    await act(async () => b.resolve({ name: 'B template' }));
    await act(async () => a.reject(new Error('old A error')));
    expect(container.textContent).toContain('B template');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps B loading when stale A %ss first',
    async (outcome) => {
      const a = deferred();
      const b = deferred();
      mocks.getDefaultTemplate
        .mockReturnValueOnce(a.promise)
        .mockReturnValueOnce(b.promise);
      await render('A');
      await render('B');
      await act(async () =>
        outcome === 'resolve'
          ? a.resolve({ name: 'A template' })
          : a.reject(new Error('old')),
      );
      expect(container.textContent).toContain('team.loading');
      expect(action().disabled).toBe(true);
      expect(mocks.error).not.toHaveBeenCalled();
      await act(async () => b.resolve({ name: 'B template' }));
      expect(action().disabled).toBe(false);
    },
  );

  it('disables creation during loading and resets the old editor on team switch', async () => {
    const a = deferred();
    const b = deferred();
    mocks.getDefaultTemplate
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    await render('A');
    expect(action().disabled).toBe(true);
    await act(async () => action().click());
    expect(mocks.dialog).not.toHaveBeenCalled();
    await act(async () => a.resolve({ name: 'A template' }));
    await act(async () => action().click());
    expect(container.querySelector('[data-dialog="A"]')).not.toBeNull();
    await render('B');
    expect(container.querySelector('[data-dialog]')).toBeNull();
    expect(container.textContent).not.toContain('A template');
    expect(action().disabled).toBe(true);
    await act(async () => b.resolve({ name: 'B template' }));
    expect(container.querySelector('[data-dialog]')).toBeNull();
    await act(async () => action().click());
    expect(mocks.dialog.mock.lastCall![0].initial.name).toBe('B template');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a request that %ss after unmount',
    async (outcome) => {
      const request = deferred();
      mocks.getDefaultTemplate.mockReturnValue(request.promise);
      await render('A');
      await act(async () => root.unmount());
      root = null;
      await act(async () =>
        outcome === 'resolve'
          ? request.resolve({ name: 'late' })
          : request.reject(new Error('late')),
      );
      expect(container.textContent).toBe('');
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.success).not.toHaveBeenCalled();
    },
  );

  it('reports a current failure and finishes loading', async () => {
    mocks.getDefaultTemplate.mockRejectedValue(new Error('current error'));
    await render('A');
    expect(mocks.error).toHaveBeenCalledWith('current error');
    expect(container.textContent).toContain('defaultAgent.empty');
    expect(action().disabled).toBe(false);
  });

  it('keeps the current empty-template and save behavior', async () => {
    mocks.getDefaultTemplate.mockResolvedValue({});
    await render('A');
    expect(container.textContent).toContain('defaultAgent.empty');
    await act(async () => action().click());
    await act(async () =>
      mocks.dialog.mock.lastCall![0].onSaved({ name: 'saved A' }),
    );
    expect(container.textContent).toContain('saved A');
    expect(container.querySelector('[data-dialog]')).toBeNull();
    expect(mocks.success).toHaveBeenCalledWith('defaultAgent.notify.saved');
  });

  it('preserves an open editor when the same team is rendered again', async () => {
    mocks.getDefaultTemplate.mockResolvedValue({ name: 'A template' });
    await render('A');
    await act(async () => action().click());
    await render('A');
    expect(container.querySelector('[data-dialog="A"]')).not.toBeNull();
    expect(container.textContent).toContain('A template');
    expect(mocks.getDefaultTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.getDefaultTemplate).toHaveBeenCalledWith('A');
  });

  it('does not accept an old dialog save after switching teams', async () => {
    mocks.getDefaultTemplate
      .mockResolvedValueOnce({ name: 'A' })
      .mockResolvedValueOnce({ name: 'B' });
    await render('A');
    await act(async () => action().click());
    const oldOnSaved = mocks.dialog.mock.lastCall![0].onSaved;
    await render('B');
    await act(async () => oldOnSaved({ name: 'late A save' }));
    expect(container.textContent).not.toContain('late A save');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('invalidates the first StrictMode effect request', async () => {
    const first = deferred();
    const second = deferred();
    mocks.getDefaultTemplate
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render('A', true);
    await act(async () => second.resolve({ name: 'current A' }));
    await act(async () => first.resolve({ name: 'stale A' }));
    expect(container.textContent).toContain('current A');
    expect(container.textContent).not.toContain('stale A');
  });

  it('rejects a stale A response even after switching A to B and back to A', async () => {
    const firstA = deferred();
    const b = deferred();
    const currentA = deferred();
    mocks.getDefaultTemplate
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(currentA.promise);
    await render('A');
    await render('B');
    await render('A');
    await act(async () => currentA.resolve({ name: 'current A' }));
    await act(async () => firstA.resolve({ name: 'stale A' }));
    await act(async () => b.reject(new Error('stale B')));
    expect(container.textContent).toContain('current A');
    expect(container.textContent).not.toContain('stale A');
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
