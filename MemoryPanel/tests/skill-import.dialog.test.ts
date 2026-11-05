/**
 * SKILL.md 目录导入的组件级回归测试（issue #1934）。
 *
 * 挂载真实的 ImportSkillDialog，验证：
 *   - LF / CRLF / CR 三种行尾提取到同一个 name，且主文件内容统一为 LF；
 *   - 只归一化 SKILL.md，文本资源保持原行尾、二进制资源保持原字节。
 *
 * 父包没有 React / jsdom，这里用 createRequire 借用 web 包已有的依赖，
 * 不改任何 package.json。
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

const { createSkill, onImported } = vi.hoisted(() => ({
  createSkill: vi.fn(),
  onImported: vi.fn(),
}));

const stableT = (key: string) => key;

vi.mock('@/lib/api/skill-api', () => ({ createSkill, extractSkills: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: stableT } }));
vi.mock('@/lib/skillFrontmatter', async () => await import('../web/src/lib/skillFrontmatter'));
vi.doMock(
  resolve(
    dirname(requireWeb.resolve('react-i18next/package.json')),
    requireWeb('react-i18next/package.json').module,
  ),
  () => ({ useTranslation: () => ({ t: stableT }) }),
);
vi.doMock(requireWeb.resolve('tea-icons-react'), () => ({ FolderOpenIcon: () => null }));
vi.doMock(requireWeb.resolve('tea-component'), () => {
  const container = ({ children }: { children: unknown }) => createElement('div', null, children);
  return {
    Modal: Object.assign(container, { Body: container, Footer: container }),
    Form: Object.assign(container, { Item: container }),
    Alert: ({ children }: { children: unknown }) =>
      createElement('div', { role: 'alert' }, children),
    Button: ({ children, onClick, disabled }: {
      children: unknown;
      onClick: () => void;
      disabled: boolean;
    }) => createElement('button', { onClick, disabled }, children),
    Segment: () => null,
    Select: () => null,
    Input: { TextArea: () => null },
  };
});

const { default: ImportSkillDialog } = await import(
  '../web/src/pages/SkillsPage/components/ImportSkillDialog'
);

const SKILL_TEXT = '---\nname: actual-skill\ndescription: A sample skill\n---\n\n# 用法\n说明。\n';

function fileAt(relativePath: string, content: string | Uint8Array): File {
  const file = new File([content], relativePath.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('SKILL.md 目录导入', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  let host: HTMLElement;

  beforeEach(async () => {
    createSkill.mockReset().mockResolvedValue({});
    onImported.mockReset();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ImportSkillDialog, {
          teamId: 'team-1',
          userId: 'user-1',
          onClose: vi.fn(),
          onImported,
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function submit(files: File[]) {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === 'importSkill.submit',
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  }

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('%s 行尾：用 YAML 里的 name，主文件统一为 LF', async (_label, eol) => {
    await submit([fileAt('folder-name/SKILL.md', SKILL_TEXT.replaceAll('\n', eol))]);

    expect(createSkill).toHaveBeenCalledOnce();
    const payload = createSkill.mock.calls[0][0];
    expect(payload.name).toBe('actual-skill');
    expect(payload.content).toContain('name: actual-skill');
    expect(payload.content).not.toContain('\r');
  });

  it('只归一化 SKILL.md，文本资源保留原行尾、二进制资源保留原字节', async () => {
    const textResource = 'line1\r\nline2\r\n';
    const binary = new Uint8Array(70 * 1024);
    binary.fill(65);
    binary[0] = 0x89;

    await submit([
      fileAt('my-skill/SKILL.md', SKILL_TEXT.replaceAll('\n', '\r\n')),
      fileAt('my-skill/files/note.txt', textResource),
      fileAt('my-skill/files/logo.png', binary),
    ]);

    expect(createSkill).toHaveBeenCalledOnce();
    const payload = createSkill.mock.calls[0][0];
    expect(payload.name).toBe('actual-skill');

    const note = payload.resources.find((r: { path: string }) => r.path === 'note.txt');
    const logo = payload.resources.find((r: { path: string }) => r.path === 'logo.png');

    // 文本资源不被归一化
    expect(note.encoding).toBe('utf-8');
    expect(note.content).toBe(textResource);

    // 二进制资源走 base64，字节不变
    expect(logo.encoding).toBe('base64');
    const bytes = Buffer.from(logo.content, 'base64');
    expect(bytes.length).toBe(binary.length);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(65);
  });

  it('YAML 和目录都没有 name 时给出明确错误，不调用 createSkill', async () => {
    await submit([fileAt('SKILL.md', '---\ndescription: 只有描述\n---\n\n正文')]);

    expect(createSkill).not.toHaveBeenCalled();
    expect(host.textContent).toContain('importSkill.error.noName');
  });
});
