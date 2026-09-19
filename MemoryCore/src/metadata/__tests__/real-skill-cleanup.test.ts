import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSkillStore } from '../../core/store/sqlite/skill-store.js';
import { SkillCore } from '../../core/skill/skill-core.js';
import { SkillVersioning } from '../../core/skill/skill-versioning.js';
import { SkillResourceStore } from '../../core/skill/skill-resource-store.js';
import { StorageAdapter } from '../../core/storage/adapter.js';
import { LocalStorageBackend } from '../../core/storage/local-backend.js';
import { createAgentSkillLifecycle } from '../service/agent-skill-lifecycle.js';

let db: DatabaseSync, dir: string, core: SkillCore, store: SqliteSkillStore, storage: StorageAdapter;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'issue1321-skills-'));
  db = new DatabaseSync(':memory:'); store = new SqliteSkillStore({ db, dimensions: 0 }); store.init();
  storage = new StorageAdapter(new LocalStorageBackend(dir));
  const resources = new SkillResourceStore({ storage });
  core = new SkillCore({ store, resources, versioning: new SkillVersioning({ store, resources, storage }) });
});
afterEach(async () => { db?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
async function seed() {
  return core.create({ team_id: 'team', agent_id: 'agent', user_id: 'owner', name: 'example', content: '---\nname: example\ndescription: lifecycle fixture\n---\nUse a fixture.', resources: [{ path: 'fixture.txt', content: 'sample resource', encoding: 'utf-8' }] });
}
it('real SkillCore removes all versions and local resources', async () => {
  const skill = await seed();
  await core.update({ team_id: 'team', agent_id: 'agent', skill_id: skill.skill_id, expected_version: 1, content: '---\nname: example\ndescription: lifecycle fixture\n---\nUpdated fixture.' });
  const versions = await store.listVersions(skill.skill_id, 'team'); expect(versions).toHaveLength(2);
  for (const v of versions) expect(await storage.exists(`${v.storage_dir}/files/fixture.txt`)).toBe(true);
  const lifecycle = createAgentSkillLifecycle(async () => core, async () => {});
  expect(await lifecycle.clean({ teamId: 'team', agentId: 'agent' })).toEqual([skill.skill_id]);
  expect(await store.listVersions(skill.skill_id, 'team')).toHaveLength(0);
  for (const v of versions) expect(await storage.exists(`${v.storage_dir}/files/fixture.txt`)).toBe(false);
});
it('strict lifecycle resource failure keeps the Skill root for a real retry', async () => {
  const skill = await seed();
  const remove = vi.spyOn(storage, 'rmdir').mockRejectedValueOnce(new Error('resource unavailable'));
  const lifecycle = createAgentSkillLifecycle(async () => core, async () => {});
  await expect(lifecycle.clean({ teamId: 'team', agentId: 'agent' })).rejects.toThrow('resource unavailable');
  expect(await store.getHead(skill.skill_id, 'team')).not.toBeNull();
  expect(await lifecycle.clean({ teamId: 'team', agentId: 'agent' })).toEqual([skill.skill_id]);
  expect(remove).toHaveBeenCalledTimes(2); expect(await store.getHead(skill.skill_id, 'team')).toBeNull();
});
