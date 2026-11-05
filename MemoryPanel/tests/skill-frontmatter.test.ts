/**
 * SKILL.md frontmatter 的 name 提取（issue #1934）。
 *
 * Windows 上保存的 SKILL.md 是 CRLF 行尾，原正则只认 LF，取不到 name 就回退成
 * 目录名，和 Core 解析出的 frontmatter.name 对不上，create 抛 INVALID_FRONTMATTER。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { describe, expect, it } from 'vitest';
import { extractFrontmatterName, normalizeNewlines } from '../web/src/lib/skillFrontmatter';

const BODY = '## 用法\n\n说明文本。\n\n---\n\n正文里也有分隔线。\n';

/** 拼一份 SKILL.md：frontmatter 是 YAML 行数组，正文固定。 */
function skillMd(frontmatter: string[], eol = '\n'): string {
  return ['---', ...frontmatter, '---', '', BODY.replace(/\n/g, eol)].join(eol);
}

describe('normalizeNewlines', () => {
  it('CRLF 与单独的 CR 都归一化成 LF', () => {
    expect(normalizeNewlines('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeNewlines('a\rb\r')).toBe('a\nb\n');
  });

  it('已经是 LF 的内容原样返回', () => {
    expect(normalizeNewlines('a\nb\n')).toBe('a\nb\n');
  });
});

describe('extractFrontmatterName', () => {
  it('LF 与 CRLF 提取到同一个 name', () => {
    const lf = skillMd(['name: actual-skill', 'description: 一个测试用的 skill'], '\n');
    const crlf = skillMd(['name: actual-skill', 'description: 一个测试用的 skill'], '\r\n');

    expect(extractFrontmatterName(lf)).toBe('actual-skill');
    expect(extractFrontmatterName(crlf)).toBe('actual-skill');
  });

  it('单独 CR 行尾也能提取（Core 侧 \\r\\n? 同样覆盖）', () => {
    const cr = skillMd(['name: actual-skill'], '\r');
    expect(extractFrontmatterName(cr)).toBe('actual-skill');
  });

  it('混合行尾（frontmatter CRLF、正文 LF）也能提取', () => {
    expect(
      extractFrontmatterName('---\r\nname: actual-skill\r\ndescription: d\r\n---\n\nbody\n'),
    ).toBe('actual-skill');
  });

  it('目录名与 YAML name 不同时用 YAML name，不走目录名回退', () => {
    const dirName = 'folder-name';
    const content = skillMd(['name: actual-skill'], '\r\n');

    // 调用方是 extractFrontmatterName(content) ?? dirName
    const name = extractFrontmatterName(content) ?? dirName;
    expect(name).toBe('actual-skill');
  });

  it('frontmatter 缺 name 时返回 null，调用方才会回退目录名', () => {
    const content = skillMd(['description: 只有描述'], '\r\n');
    expect(extractFrontmatterName(content)).toBeNull();
  });

  it('没有 frontmatter 时返回 null', () => {
    expect(extractFrontmatterName('# 标题\n\n直接是正文\n')).toBeNull();
  });

  it('name 值为空时返回 null', () => {
    expect(extractFrontmatterName(skillMd(['name:   ']))).toBeNull();
  });

  it('name 在 description 之后也能取到', () => {
    const content = skillMd(['description: 描述在前', 'name: actual-skill'], '\r\n');
    expect(extractFrontmatterName(content)).toBe('actual-skill');
  });

  it('去掉包裹的引号', () => {
    expect(extractFrontmatterName(skillMd(['name: "quoted-name"']))).toBe('quoted-name');
    expect(extractFrontmatterName(skillMd(["name: 'quoted-name'"]))).toBe('quoted-name');
  });

  it('正文里的 name 行不会被误当成 frontmatter 的 name', () => {
    // 贪婪匹配会把捕获范围延伸到正文末尾的 `---`，从而读到 name: fake
    const content = '---\ndescription: 只有描述\n---\n\nname: fake\n\n---\n';
    expect(extractFrontmatterName(content)).toBeNull();
  });
});
