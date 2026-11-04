import { diffLines } from 'diff';
export interface DiffLine {
  number: number;
  text: string;
  eof: boolean;
}
export interface DiffRow {
  before?: DiffLine;
  after?: DiffLine;
  changed: boolean;
  anchor?: number;
}
export function buildSkillDiff(before: string, after: string): DiffRow[] | null {
  if (
    before.length + after.length > 200_000 ||
    before.split('\n').length + after.split('\n').length > 4000
  )
    return null;
  const changes = diffLines(before, after, { timeout: 50, maxEditLength: 1500 });
  if (!changes) return null;
  let oldLine = 1,
    newLine = 1,
    anchor = 0;
  const rows: DiffRow[] = [];
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const line = (text: string, number: number): DiffLine => ({
    number,
    text: text.replace(/\r?\n$/, ''),
    eof: !text.endsWith('\n'),
  });
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      for (const text of lines(part.value))
        rows.push({ before: line(text, oldLine++), after: line(text, newLine++), changed: false });
    } else {
      const removed = part.removed ? lines(part.value) : [];
      let added = part.added ? lines(part.value) : [];
      if (part.removed && changes[i + 1]?.added) added = lines(changes[++i].value);
      const id = anchor++;
      for (let n = 0; n < Math.max(removed.length, added.length); n++)
        rows.push({
          before: n < removed.length ? line(removed[n], oldLine++) : undefined,
          after: n < added.length ? line(added[n], newLine++) : undefined,
          changed: true,
          ...(n === 0 ? { anchor: id } : {}),
        });
    }
  }
  return rows;
}
export function visibleDiffRows(
  rows: DiffRow[],
  expanded: boolean,
): Array<DiffRow | { hidden: number; key: number }> {
  if (expanded) return rows;
  const keep = new Set<number>();
  rows.forEach((row, i) => {
    if (row.changed)
      for (let n = Math.max(0, i - 3); n <= Math.min(rows.length - 1, i + 3); n++) keep.add(n);
  });
  const output: Array<DiffRow | { hidden: number; key: number }> = [];
  for (let i = 0; i < rows.length;) {
    if (keep.has(i)) {
      output.push(rows[i++]);
      continue;
    }
    const start = i;
    while (i < rows.length && !keep.has(i)) i++;
    output.push({ hidden: i - start, key: start });
  }
  return output;
}
