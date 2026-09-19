import { expect, it, vi } from 'vitest';
import { createAgentSkillLifecycle } from '../service/agent-skill-lifecycle.js';
const target = { teamId: 'team', agentId: 'agent' };
function fixture(count = 205) {
  const rows = Array.from({ length: count }, (_, i) => ({ skill_id: `s${i}`, team_id: 'team', owner_agent_id: 'agent' }));
  const core = {
    list: vi.fn(async ({ pagination }: any) => ({ items: rows.slice(pagination.offset, pagination.offset + pagination.limit), total: rows.length })),
    delete: vi.fn(async ({ skill_id }: any) => { rows.splice(rows.findIndex((s) => s.skill_id === skill_id), 1); return { skill_id, archived: true }; }),
  };
  const meta = vi.fn(async (_ids: string[]) => {});
  return { rows, core, meta, lifecycle: createAgentSkillLifecycle(async () => core as any, meta) };
}
it('disabled SkillCore is explicit no-op', async () => {
  const lifecycle = createAgentSkillLifecycle(async () => null, vi.fn());
  expect(await lifecycle.clean(target)).toEqual([]); expect(await lifecycle.ownedAssetIds(target)).toEqual([]);
});
it('collects all 205 owned IDs without mutation', async () => {
  const f = fixture(); expect(await f.lifecycle.ownedAssetIds(target)).toHaveLength(205);
  expect(f.rows).toHaveLength(205); expect(f.core.delete).not.toHaveBeenCalled();
});
it('drains 205 skills from offset zero and awaits metadata cleanup', async () => {
  const f = fixture(); expect(await f.lifecycle.clean(target)).toHaveLength(205);
  expect(f.rows).toHaveLength(0); expect(f.meta).toHaveBeenCalledTimes(205);
  expect(f.core.list.mock.calls.every(([x]) => x.pagination.offset === 0)).toBe(true);
});
it('propagates storage errors and can resume remaining skills', async () => {
  const f = fixture(3); f.core.delete.mockRejectedValueOnce(new Error('storage failure'));
  await expect(f.lifecycle.clean(target)).rejects.toThrow('storage failure');
  expect(f.meta).toHaveBeenCalledTimes(1); expect(await f.lifecycle.clean(target)).toHaveLength(3);
});
it('rejects an out-of-scope skill before deleting anything', async () => {
  const f = fixture(1); f.rows[0]!.owner_agent_id = 'other';
  await expect(f.lifecycle.clean(target)).rejects.toThrow('scope mismatch');
  expect(f.core.delete).not.toHaveBeenCalled();
});
it('fails rather than looping when storage reports success without deleting', async () => {
  const f = fixture(1); f.core.delete.mockImplementation(async () => ({ skill_id: 's0', archived: true }));
  await expect(f.lifecycle.clean(target)).rejects.toThrow('no progress');
});

it('metadata failure happens before Skill deletion and is retryable', async () => {
  const f = fixture(2); f.meta.mockRejectedValueOnce(new Error('metadata down'));
  await expect(f.lifecycle.clean(target)).rejects.toThrow('metadata down');
  expect(f.core.delete).not.toHaveBeenCalled(); expect(f.rows).toHaveLength(2);
  expect(await f.lifecycle.clean(target)).toHaveLength(2);
});
it('transfer discovery rejects a borrowed skill returned outside the requested scope', async () => {
  const f = fixture(1); f.rows[0]!.team_id = 'other';
  await expect(f.lifecycle.ownedAssetIds(target)).rejects.toThrow('scope mismatch');
});
