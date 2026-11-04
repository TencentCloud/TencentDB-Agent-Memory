import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillReview from '../src/pages/SkillsPage/components/SkillReview';
import { buildSkillDiff, visibleDiffRows } from '../src/pages/SkillsPage/utils/skill-diff';
import type { SkillReviewFile } from '../src/lib/api/skill-api';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const side = (text: string) => ({
  text,
  size: text.length,
  hash: 'a'.repeat(64),
  executable: false,
});
const body: SkillReviewFile = {
  path: 'SKILL.md',
  status: 'changed',
  before: side('old\n'),
  after: side('new\n'),
};
const attachment: SkillReviewFile = {
  path: 'guide.md',
  status: 'changed',
  before: side('before\n'),
  after: side('after\n'),
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(files: SkillReviewFile[], loadFile = vi.fn().mockResolvedValue(attachment)) {
  await act(async () =>
    root.render(
      <SkillReview
        name="demo"
        beforeLabel="v1"
        afterLabel="v2"
        files={files}
        beforeContent="old\n"
        afterContent="new\n"
        loadFile={loadFile}
        details={<p>source</p>}
        actions={<button>confirm</button>}
      />,
    ),
  );
  return loadFile;
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw Error('Missing ' + text);
  await act(async () => button.click());
}
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
});
describe('package review interactions', () => {
  it('loads only selected attachments, supports retry and ignores late responses for another file', async () => {
    let resolve!: (f: SkillReviewFile) => void;
    const loader = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(attachment);
    await render([body, attachment], loader);
    expect(loader).not.toHaveBeenCalled();
    await click('guide.md');
    expect(loader).toHaveBeenCalledWith('guide.md', expect.any(AbortSignal));
    await click('SKILL.md');
    expect(loader.mock.calls[0][1].aborted).toBe(true);
    await act(async () => resolve(attachment));
    expect(container.querySelector('.skill-review-filename')?.textContent).toContain('SKILL.md');
    await click('guide.md');
    expect(container.textContent).toContain('temporary failure');
    await click('skills.review.retry');
    expect(container.querySelector('.skill-diff-cell.added code')?.textContent).toBe('after');
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('renders binary summaries instead of pretending omitted data is empty text', async () => {
    const binary: SkillReviewFile = {
      path: 'icon.png',
      status: 'added',
      before: null,
      after: { ...side(''), reason: 'binary', text: undefined },
    };
    await render([body, binary], vi.fn().mockResolvedValue(binary));
    await click('icon.png');
    expect(container.textContent).toContain('skills.review.binary');
    expect(container.querySelector('.skill-diff-row')).toBeNull();
  });
  it('shows a no-change state and allows browsing unchanged files', async () => {
    await render([{ ...body, status: 'unchanged' }]);
    expect(container.textContent).toContain('skills.review.noChanges');
    expect(container.querySelector('.skill-diff-row')).toBeNull();
    await click('skills.review.browse');
    expect(container.querySelector('.skill-review-file')?.textContent).toContain('SKILL.md');
  });
  it('supports keyboard change navigation and Markdown preview without embedded media requests', async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const malicious = {
      ...body,
      after: side('![tracking](https://tracker.invalid/image)\n<script>bad()</script>'),
    };
    await act(async () =>
      root.render(
        <SkillReview
          name="demo"
          beforeLabel="v1"
          afterLabel="v2"
          files={[malicious]}
          beforeContent="old\n"
          afterContent={malicious.after.text}
          loadFile={vi.fn()}
          details={null}
          actions={null}
        />,
      ),
    );
    await act(async () =>
      container
        .querySelector('.skill-review-canvas')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
        ),
    );
    expect(scroll).toHaveBeenCalled();
    await click('skills.review.read');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
