import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAndIngestModal } from '../src/pages/WikiPage/components/import-and-ingest-modal';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/tea-bridge', () => ({ tea: { notify: { warning: vi.fn(), error: vi.fn() } } }));
vi.mock('tea-icons-react', () => ({ AttachIcon: () => null }));
vi.mock('../src/pages/WikiPage/components/wiki-source-page-tree', () => ({
  WikiSourcePageTree: () => null,
}));
// Replace only presentation widgets. React state, selection, validation and
// asynchronous submission below are the actual modal implementation.
vi.mock('tea-component', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: any) => h('div', {}, children);
  const Modal = Object.assign(
    ({ visible, children, onClose }: any) =>
      visible ? h('div', {}, h('button', { onClick: onClose }, 'close'), children) : null,
    { Body: box, Footer: box },
  );
  return {
    Modal,
    Tabs: box,
    TabPanel: ({ id, children }: any) => (id === 'file' ? h('div', {}, children) : null),
    Button: ({ children, disabled, onClick }: any) => h('button', { disabled, onClick }, children),
    Text: box,
    Alert: box,
    Input: box,
    Select: box,
  };
});

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'File'] as const)
    vi.stubGlobal(key, dom.window[key]);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  vi.unstubAllGlobals();
});
function doc(relativePath: string, content = 'body') {
  const file = new File([content], relativePath.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}
async function select(files: File[]) {
  const input = container.querySelector('input[webkitdirectory]') as HTMLInputElement;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
function submit() {
  return [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'wiki.import.uploadAndIngest',
  )!;
}

describe('folder picker and retry UX', () => {
  it('displays full relative paths and replaces a reselected file without duplicating it', async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () =>
      root.render(
        createElement(ImportAndIngestModal, {
          visible: true,
          submitting: false,
          onClose: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const first = doc('handbook/a/README.md');
    const second = doc('handbook/b/README.md');
    await select([first, second]);
    const replacement = doc(first.webkitRelativePath, 'updated');
    await select([replacement]);
    expect([...container.querySelectorAll('li')].map((li) => li.firstChild?.textContent)).toEqual([
      'handbook/a/README.md',
      'handbook/b/README.md',
    ]);
    await act(async () => submit().click());
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'files', localFiles: [replacement, second] });
  });

  it('prevents double submission and closing while pending, then retains files for retry', async () => {
    let acknowledge!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        createElement(ImportAndIngestModal, {
          visible: true,
          submitting: false,
          onClose,
          onSubmit,
        }),
      ),
    );
    const files = [doc('root/a.md'), doc('root/b.md')];
    await select(files);
    await act(async () => {
      submit().click();
      submit().click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit().disabled).toBe(true);
    expect((container.querySelector('input[webkitdirectory]') as HTMLInputElement).disabled).toBe(
      true,
    );
    await act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'close')!.click(),
    );
    expect(onClose).not.toHaveBeenCalled();
    // The parent keeps visible=true after reporting an upload error.
    await act(async () => acknowledge());
    expect(submit().disabled).toBe(false);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    await act(async () => submit().click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0]).toEqual(onSubmit.mock.calls[1]);
    await act(async () => acknowledge());
  });
});
