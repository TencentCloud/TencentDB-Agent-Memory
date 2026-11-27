import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The dialog's existing React and jsdom dependencies live in the web package.
const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');
const { zipSync } = requireWeb('fflate');
const { createSkill, onImported } = vi.hoisted(() => ({
  createSkill: vi.fn(),
  onImported: vi.fn(),
}));

vi.mock('@/lib/api/skill-api', () => ({ createSkill, extractSkills: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.doMock(resolve(
  dirname(requireWeb.resolve('react-i18next/package.json')),
  requireWeb('react-i18next/package.json').module,
), () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.doMock(requireWeb.resolve('tea-icons-react'), () => ({ FolderOpenIcon: () => null }));
vi.doMock(requireWeb.resolve('tea-component'), () => {
  const container = ({ children }: { children: unknown }) => createElement('div', null, children);
  return {
    Modal: Object.assign(container, { Body: container, Footer: container }),
    Form: Object.assign(container, { Item: container }),
    Alert: ({ children }: { children: unknown }) => createElement('div', { role: 'alert' }, children),
    Button: ({ children, onClick, disabled }: { children: unknown; onClick: () => void; disabled: boolean }) =>
      createElement('button', { onClick, disabled }, children),
    Segment: ({ options, onChange }: {
      options: { value: string; text: string }[];
      onChange: (value: string) => void;
    }) => createElement('div', null, options.map(({ value, text }) =>
      createElement('button', { key: value, onClick: () => onChange(value) }, text),
    )),
    Select: () => null,
    Input: { TextArea: () => null },
  };
});

const { default: ImportSkillDialog } = await import('../web/src/pages/SkillsPage/components/ImportSkillDialog');
const skillText = '---\nname: actual-skill\ndescription: A sample skill\n---\n\n# Instructions\nDo the work.\n';

function fileAt(relativePath: string, content: string | Uint8Array): File {
  const file = new File([content], relativePath.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('Skill file import', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    createSkill.mockReset().mockResolvedValue({});
    onImported.mockReset();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(ImportSkillDialog, {
        teamId: 'team-1', userId: 'user-1', onClose: vi.fn(), onImported,
      }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function clickButton(label: string) {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
    await vi.waitFor(() => expect(button.disabled, host.textContent ?? undefined).toBe(false));
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }

  async function submit(files: File[], label = 'importSkill.submit') {
    const input = host.querySelector('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await vi.dynamicImportSettled();
    });
    await clickButton(label);
  }

  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']])(
    'uses the YAML name and sends LF-normalized main content for %s',
    async (_label, eol) => {
      await submit([fileAt('folder-name/SKILL.md', skillText.replaceAll('\n', eol))]);
      expect(createSkill).toHaveBeenCalledOnce();
      expect(createSkill).toHaveBeenCalledWith({
        user_id: 'user-1', team_id: 'team-1', agent_id: 'user-1',
        name: 'actual-skill', content: skillText, resources: undefined,
      });
      expect(host.textContent).toContain('importSkill.result.directory');
    },
  );

  it('accepts a ZIP with CR line endings and sends the same normalized main content', async () => {
    await clickButton('importSkill.mode.zip');
    const archive = zipSync({
      'folder-name/SKILL.md': new TextEncoder().encode(skillText.replaceAll('\n', '\r')),
    });
    await submit([new File([archive], 'skill.zip')], 'importSkill.zip.submit');
    expect(createSkill).toHaveBeenCalledOnce();
    expect(createSkill.mock.calls[0][0]).toMatchObject({ name: 'actual-skill', content: skillText });
  });

  it('falls back to the directory name only when the frontmatter name is absent', async () => {
    const content = '---\r\ndescription: A sample skill\r\n---\r\nBody';
    await submit([fileAt('folder-name/SKILL.md', content)]);
    expect(createSkill.mock.calls[0][0]).toMatchObject({
      name: 'folder-name', content: content.replaceAll('\r\n', '\n'),
    });
  });

  it('shows the existing error when neither YAML nor directory provides a name', async () => {
    await submit([fileAt('SKILL.md', '---\r\ndescription: A sample skill\r\n---\r\nBody')]);
    expect(createSkill).not.toHaveBeenCalled();
    expect(host.textContent).toContain('importSkill.error.noName');
  });

  it.each(['name', 'description'])('surfaces the Core validation error for a missing %s', async (field) => {
    const message = `[skill][format] frontmatter missing required field '${field}'`;
    createSkill.mockRejectedValueOnce(new Error(message));
    const content = skillText.replace(new RegExp(`^${field}:.*\n`, 'm'), '').replaceAll('\n', '\r\n');
    await submit([fileAt('folder-name/SKILL.md', content)]);
    expect(createSkill).toHaveBeenCalledOnce();
    // Missing required frontmatter is still sent to Core for validation, not silently filled in.
    expect(createSkill.mock.calls[0][0].content).not.toMatch(new RegExp(`^${field}:`, 'm'));
    expect(host.textContent).toContain(message);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('preserves binary bytes and text-resource line endings while normalizing only SKILL.md', async () => {
    const binary = new Uint8Array(70_000);
    binary.set([0, 255, 13, 10, 128, 254]);
    const script = '#!/bin/sh\r\necho hello\r\n';
    await submit([
      fileAt('folder-name/SKILL.md', skillText.replaceAll('\n', '\r\n')),
      fileAt('folder-name/files/image.png', binary),
      fileAt('folder-name/files/run.sh', script),
    ]);
    const payload = createSkill.mock.calls[0][0];
    expect(payload.content).toBe(skillText);
    expect(payload.resources).toEqual([
      { path: 'image.png', content: Buffer.from(binary).toString('base64'), encoding: 'base64' },
      { path: 'run.sh', content: script, encoding: 'utf-8' },
    ]);
  });
});
