import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GitHubSkillForm from '../src/pages/SkillsPage/components/GitHubSkillForm';
import { previewGitHubSkill, applyGitHubSkill, detachGitHubSkill } from '../src/lib/api/skill-api';
vi.mock('../src/lib/api/skill-api', () => ({
  previewGitHubSkill: vi.fn(),
  applyGitHubSkill: vi.fn(),
  detachGitHubSkill: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const context = { team_id: 'team-a', agent_id: 'agent-a', user_id: 'user-a', skill_id: 'skill-a' };
const preview = {
  source: {
    repository: 'https://github.com/example/skills',
    ref: 'main',
    path: '',
    commit: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    checked_at: '2026-11-04',
  },
  name: 'demo',
  description: 'test',
  content: 'upstream',
  previous_content: 'local',
  expected_version: 3,
  local_modified: true,
  update_available: true,
  files: { added: ['new.md'], changed: ['guide.md'], removed: ['old.md'] },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(previewGitHubSkill).mockResolvedValue(preview);
  vi.mocked(applyGitHubSkill).mockResolvedValue({} as never);
  vi.mocked(detachGitHubSkill).mockResolvedValue({} as never);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
function button(key: string) {
  const b = [...container.querySelectorAll('button')].find((b) => b.textContent === key);
  if (!b) throw new Error(`Missing button ${key}`);
  return b;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
describe('GitHub Skill confirmation UI', () => {
  it('requires preview and explicit overwrite consent, and submits the exact preview commit', async () => {
    const done = vi.fn();
    await act(async () => root.render(<GitHubSkillForm context={context} onImported={done} />));
    expect(applyGitHubSkill).not.toHaveBeenCalled();
    await click(button('skills.github.check'));
    expect(container.textContent).toContain('guide.md');
    expect(container.textContent).toContain(preview.source.commit);
    const upgrade = button('skills.github.upgrade');
    expect(upgrade.disabled).toBe(true);
    await click(upgrade);
    expect(applyGitHubSkill).not.toHaveBeenCalled();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await click(checkbox);
    expect(button('skills.github.upgrade').disabled).toBe(false);
    await click(button('skills.github.upgrade'));
    expect(applyGitHubSkill).toHaveBeenCalledWith({
      ...context,
      expected_version: 3,
      commit: preview.source.commit,
      digest: preview.source.digest,
      overwrite_local: true,
    });
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('detaches local edits without applying the upstream package', async () => {
    const done = vi.fn();
    await act(async () => root.render(<GitHubSkillForm context={context} onImported={done} />));
    await click(button('skills.github.check'));
    await click(button('skills.github.detach'));
    expect(detachGitHubSkill).toHaveBeenCalledWith({ ...context, expected_version: 3 });
    expect(applyGitHubSkill).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('shows errors without reporting success and permits retry', async () => {
    vi.mocked(previewGitHubSkill).mockRejectedValueOnce(new Error('rate limited'));
    const done = vi.fn();
    await act(async () => root.render(<GitHubSkillForm context={context} onImported={done} />));
    await click(button('skills.github.check'));
    expect(container.textContent).toContain('rate limited');
    expect(done).not.toHaveBeenCalled();
    await click(button('skills.github.check'));
    expect(container.textContent).toContain(preview.source.commit);
    expect(applyGitHubSkill).not.toHaveBeenCalled();
  });
  it('invalidates an installation preview when the repository input changes', async () => {
    vi.mocked(previewGitHubSkill).mockResolvedValue({
      ...preview,
      local_modified: false,
      expected_version: 0,
    });
    const done = vi.fn();
    await act(async () =>
      root.render(
        <GitHubSkillForm
          context={{ team_id: 'team-a', agent_id: 'agent-a', user_id: 'user-a' }}
          onImported={done}
        />,
      ),
    );
    const input = container.querySelector(
      'input[placeholder="https://github.com/owner/repository"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    async function change(value: string) {
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await change('https://github.com/example/skills');
    await click(button('skills.github.preview'));
    expect(button('skills.github.install').disabled).toBe(false);
    await change('https://github.com/example/different');
    expect(container.textContent).not.toContain('skills.github.install');
    expect(applyGitHubSkill).not.toHaveBeenCalled();
  });
});
