import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillDetailCache } from '../src/services/use-skill-detail-cache';
import { getSkill } from '../src/lib/api/skill-api';
vi.mock('../src/lib/api/skill-api', () => ({ getSkill: vi.fn() }));
let root: Root, container: HTMLDivElement;
let cache: ReturnType<typeof useSkillDetailCache>;
function Harness({ team }: { team: string }) {
  cache = useSkillDetailCache(team);
  return null;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
describe('Skill list version cache', () => {
  it('refreshes after publication and ignores a slower response for an older version', async () => {
    let resolveOld!: (value: any) => void;
    vi.mocked(getSkill).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    vi.mocked(getSkill).mockResolvedValueOnce({ version: 3, owner_agent_id: 'agent-a' } as never);
    await act(async () => root.render(<Harness team="a" />));
    const old = cache.preload('skill');
    await act(async () => cache.preload('skill', true));
    await act(async () => {
      resolveOld({ version: 1, owner_agent_id: 'agent-a' });
      await old;
    });
    expect(cache.getFromCache('skill')?.version).toBe(3);
    await act(async () => cache.preload('skill'));
    expect(getSkill).toHaveBeenCalledTimes(2);
  });
  it('never reuses another team’s cached owner or version for the same skill id', async () => {
    vi.mocked(getSkill).mockResolvedValueOnce({ version: 7, owner_agent_id: 'agent-a' } as never);
    await act(async () => root.render(<Harness team="a" />));
    await act(async () => cache.preload('same-id'));
    await act(async () => root.render(<Harness team="b" />));
    expect(cache.getFromCache('same-id')).toBeUndefined();
    vi.mocked(getSkill).mockResolvedValueOnce({ version: 2, owner_agent_id: 'agent-b' } as never);
    await act(async () => cache.preload('same-id'));
    expect(cache.getFromCache('same-id')).toEqual({ version: 2, owner_agent_id: 'agent-b' });
  });
});
