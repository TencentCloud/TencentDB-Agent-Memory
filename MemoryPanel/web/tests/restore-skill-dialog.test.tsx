import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestoreSkillDialog from '../src/pages/SkillsPage/components/RestoreSkillDialog';
import { previewSkillRestore, restoreSkillVersion } from '../src/lib/api/skill-api';
vi.mock('../src/lib/api/skill-api', () => ({
  previewSkillRestore: vi.fn(),
  restoreSkillVersion: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const context = { team_id: 'team-a', agent_id: 'agent-a', user_id: 'user-a', skill_id: 'skill-a' };
const preview = {
  source_version: 1,
  expected_version: 4,
  digest: 'a'.repeat(64),
  name: 'demo',
  content: 'historical content',
  previous_content: 'current content',
  source: null,
  files: { added: ['old.md'], changed: ['guide.md'], removed: ['new.md'] },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(previewSkillRestore).mockResolvedValue(preview);
  vi.mocked(restoreSkillVersion).mockResolvedValue({} as never);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
function button(key: string) {
  const result = [...document.querySelectorAll('button')].find((b) => b.textContent === key);
  if (!result) throw new Error(`Missing button ${key}`);
  return result;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function render() {
  const onClose = vi.fn(),
    onRestored = vi.fn();
  await act(async () =>
    root.render(
      <RestoreSkillDialog
        context={context}
        sourceVersion={1}
        onClose={onClose}
        onRestored={onRestored}
      />,
    ),
  );
  return { onClose, onRestored };
}
describe('historical Skill restore confirmation', () => {
  it('previews the full package and requires explicit consent before publishing the exact reviewed version', async () => {
    const done = await render();
    expect(button('skills.restore.confirm').disabled).toBe(true);
    await click(button('skills.restore.preview'));
    expect(previewSkillRestore).toHaveBeenCalledWith({ ...context, source_version: 1 });
    for (const value of ['historical content', 'current content', 'old.md', 'guide.md', 'new.md'])
      expect(document.body.textContent).toContain(value);
    expect(button('skills.restore.confirm').disabled).toBe(true);
    await click(document.querySelector('input[type="checkbox"]') as HTMLElement);
    await click(button('skills.restore.confirm'));
    expect(restoreSkillVersion).toHaveBeenCalledWith({
      ...context,
      source_version: 1,
      expected_version: 4,
      digest: preview.digest,
    });
    expect(done.onRestored).toHaveBeenCalledTimes(1);
  });
  it('does not publish on cancel and resets consent when refreshing a preview', async () => {
    const done = await render();
    await click(button('skills.restore.preview'));
    await click(document.querySelector('input[type="checkbox"]') as HTMLElement);
    await click(button('skills.restore.preview'));
    expect(button('skills.restore.confirm').disabled).toBe(true);
    await click(button('importSkill.cancel'));
    expect(done.onClose).toHaveBeenCalledTimes(1);
    expect(restoreSkillVersion).not.toHaveBeenCalled();
  });
  it('keeps a failed restore visible and obtains a fresh expected version before retrying', async () => {
    vi.mocked(restoreSkillVersion).mockRejectedValueOnce(new Error('Skill changed; preview again'));
    const done = await render();
    await click(button('skills.restore.preview'));
    await click(document.querySelector('input[type="checkbox"]') as HTMLElement);
    await click(button('skills.restore.confirm'));
    expect(done.onRestored).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Skill changed; preview again');
    vi.mocked(previewSkillRestore).mockResolvedValue({ ...preview, expected_version: 5 });
    await click(button('skills.restore.preview'));
    await click(document.querySelector('input[type="checkbox"]') as HTMLElement);
    await click(button('skills.restore.confirm'));
    expect(restoreSkillVersion).toHaveBeenLastCalledWith({
      ...context,
      source_version: 1,
      expected_version: 5,
      digest: preview.digest,
    });
    expect(done.onRestored).toHaveBeenCalledTimes(1);
  });
});
