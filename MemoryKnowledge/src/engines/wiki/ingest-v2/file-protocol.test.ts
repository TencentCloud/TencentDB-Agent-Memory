import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWikiPath, parseFileBlocks } from './file-protocol.js';
import { isInsideRoot } from './safe-path.js';

describe('LLM output filesystem boundary', () => {
  it.each(['', ' ', '/', '/wiki/a.md', 'C:\\wiki\\a.md', '../wiki/a.md',
    'wiki/../secret', 'wiki/./a.md', 'wiki\\..\\secret', 'wiki', 'wiki/',
    'wiki-evil/a.md', 'other/a.md'])('rejects unsafe path %j', (path) => {
    expect(normalizeWikiPath(path)).toBeNull();
  });

  it.each([
    ['wiki/sources/a.md', 'wiki/sources/a.md'],
    ['./wiki//sources/a.md', 'wiki/sources/a.md'],
    [' wiki\\entities\\a.md ', 'wiki/entities/a.md'],
  ])('normalizes %j without leaving wiki', (input, expected) => {
    expect(normalizeWikiPath(input)).toBe(expected);
  });

  it('keeps valid blocks while rejecting traversal, empty and truncated blocks', () => {
    const result = parseFileBlocks([
      'LLM commentary',
      '<<<FILE path="../secret">>>\nsecret\n<<<END>>>',
      '<<<FILE path="wiki/a.md">>>\n---\ntype: source\n---\nhello\n<<<END>>>',
      '<<<FILE path="wiki/empty.md">>>\n \n<<<END>>>',
      '<<<FILE path="wiki/truncated.md">>>\nincomplete',
    ].join('\n'));
    expect(result.files).toEqual([{ path: 'wiki/a.md', content: '---\ntype: source\n---\nhello\n' }]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toContain('../secret');
    expect(result.warnings.join('\n')).toContain('wiki/truncated.md');
  });

  it('accepts documented delimiter variations and resets parser state between calls', () => {
    const text = '<<<FILE path="wiki/a.md">>\r\nhello\r\n<<<\nEND >>>';
    const expected = { files: [{ path: 'wiki/a.md', content: 'hello\n' }], warnings: [] };
    expect(parseFileBlocks(text)).toEqual(expected);
    expect(parseFileBlocks('')).toEqual({ files: [], warnings: [] });
    expect(parseFileBlocks(text)).toEqual(expected);
  });

  it('checks directory boundaries, not just string prefixes', () => {
    const root = resolve('test-project');
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(root, resolve(root, 'wiki', 'a.md'))).toBe(true);
    expect(isInsideRoot(root, resolve(root, 'wiki', '..', 'a.md'))).toBe(true);
    expect(isInsideRoot(root, `${root}-evil/a.md`)).toBe(false);
    expect(isInsideRoot(root, resolve(root, '..', 'secret'))).toBe(false);
  });
});
