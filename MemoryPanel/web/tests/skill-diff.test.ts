import { describe, expect, it } from 'vitest';
import { buildSkillDiff, visibleDiffRows } from '../src/pages/SkillsPage/utils/skill-diff';

describe('bounded diff model', () => {
  it('aligns replacements and preserves source line numbers and missing final newline', () => {
    const rows = buildSkillDiff('same\nold\nlast', 'same\nnew\nextra\nlast\n')!;
    expect(rows[0]).toMatchObject({
      before: { number: 1, text: 'same' },
      after: { number: 1, text: 'same' },
      changed: false,
    });
    expect(rows.some((r) => r.before?.text === 'old' && r.after?.text === 'new' && r.changed)).toBe(
      true,
    );
    expect(rows.find((r) => r.before?.text === 'last')?.before?.eof).toBe(true);
    expect(rows.find((r) => r.after?.text === 'last')?.after?.number).toBe(4);
  });
  it('folds long context but keeps changed lines and three lines around them', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}\n`);
    const after = [...lines];
    after[50] = 'changed\n';
    const rows = buildSkillDiff(lines.join(''), after.join(''))!;
    const folded = visibleDiffRows(rows, false);
    expect(folded).toHaveLength(9);
    expect(folded[0]).toEqual({ hidden: 47, key: 0 });
    expect(visibleDiffRows(rows, true)).toHaveLength(100);
  });
  it('returns summary fallback for huge or highly divergent input', () => {
    expect(buildSkillDiff('a'.repeat(200001), 'b')).toBeNull();
    expect(buildSkillDiff('a\n'.repeat(2000), 'b\n'.repeat(2000))).toBeNull();
  });
  it.each([
    { before: '', after: 'alpha\nbeta', kind: 'after' as const, missing: 'before' as const },
    { before: 'alpha\nbeta', after: '', kind: 'before' as const, missing: 'after' as const },
  ])(
    'keeps source line numbers for an entirely added or removed file ($kind)',
    ({ before, after, kind, missing }) => {
      const rows = buildSkillDiff(before, after)!;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row[kind])).toEqual([
        { number: 1, text: 'alpha', eof: false },
        { number: 2, text: 'beta', eof: true },
      ]);
      expect(rows.every((row) => row.changed && row[missing] === undefined)).toBe(true);
      expect(rows.filter((row) => row.anchor !== undefined)).toHaveLength(1);
    },
  );
  it('does not invent a blank changed line when both versions are empty', () => {
    expect(buildSkillDiff('', '')).toEqual([]);
  });
});
