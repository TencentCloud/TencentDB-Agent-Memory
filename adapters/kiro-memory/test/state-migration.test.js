import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { StateMigrationService } from '../src/core/state-migration.js';

test('migration accepts a smaller scan bound but never exceeds the hard limit', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-bound-'));
  try {
    await mkdir(join(stateDir, 'sessions', 'hash', 'turns'), { recursive: true });
    await writeFile(join(stateDir, 'sessions', 'hash', 'turns', 'a.json'), '{"version":1,"legacy":true}\n');
    await writeFile(join(stateDir, 'sessions', 'hash', 'turns', 'b.json'), '{"version":1,"legacy":true}\n');

    await assert.rejects(
      new StateMigrationService({ stateDir, maxObjects: 1 }).migrate(),
      /Migration scan limit exceeded/,
    );
    assert.throws(
      () => new StateMigrationService({ stateDir, maxObjects: 10001 }),
      /Invalid migration scan limit/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('migration freezes a deterministic plan, verifies legacy objects, and publishes v2 manifest last', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-'));
  try {
    const legacyPath = join(stateDir, 'sessions', 'hash', 'turns', 'legacy.json');
    await mkdir(join(stateDir, 'sessions', 'hash', 'turns'), { recursive: true });
    const legacy = '{"version":1,"legacy":true}\n';
    await writeFile(legacyPath, legacy);
    const service = new StateMigrationService({ stateDir, now: () => new Date('2026-08-16T04:00:00.000Z') });
    const result = await service.migrate();
    assert.equal(result.status, 'migrated');
    assert.equal(await readFile(legacyPath, 'utf8'), legacy);
    assert.equal(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).version, 2);
    const plan = JSON.parse(await readFile(join(stateDir, '.migration', 'v1-to-v2', 'plan.json'), 'utf8'));
    assert.deepEqual(plan.objects.map((item) => item.path), ['sessions/hash/turns/legacy.json']);
    const receipt = JSON.parse(await readFile(join(stateDir, '.migration', 'v1-to-v2', 'receipt.json'), 'utf8'));
    assert.equal(receipt.verified_objects, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('migration resumes the same immutable plan after a crash', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-resume-'));
  try {
    await writeFile(join(stateDir, 'legacy.json'), '{"version":1}\n');
    const crashing = new StateMigrationService({ stateDir, afterPlan: async () => { throw new Error('crash'); } });
    await assert.rejects(crashing.migrate(), /crash/);
    const planBefore = await readFile(join(stateDir, '.migration', 'v1-to-v2', 'plan.json'), 'utf8');
    await new StateMigrationService({ stateDir }).migrate();
    assert.equal(await readFile(join(stateDir, '.migration', 'v1-to-v2', 'plan.json'), 'utf8'), planBefore);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('unknown future state versions are read-only and migration refuses mutation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-future-'));
  try {
    await writeFile(join(stateDir, 'state.json'), '{"version":3,"adapter":"future"}\n');
    await assert.rejects(new StateMigrationService({ stateDir }).migrate(), /future/);
    assert.equal(JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).version, 3);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('migration validation refuses a future-version payload before publishing a v2 manifest', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-future-object-'));
  try {
    const payload = join(stateDir, 'legacy.json');
    await writeFile(payload, '{"version":3,"future":true}\n');
    await assert.rejects(new StateMigrationService({ stateDir }).migrate(), /future/);
    await assert.rejects(readFile(join(stateDir, 'state.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(payload, 'utf8'), '{"version":3,"future":true}\n');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('migration resumes after an object checkpoint and after manifest publication', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-migrate-stages-'));
  try {
    await writeFile(join(stateDir, 'a.json'), '{"version":1}\n');
    await writeFile(join(stateDir, 'b.json'), '{"version":1}\n');
    let crashedObject = false;
    await assert.rejects(new StateMigrationService({
      stateDir,
      afterObject: async (index) => { if (index === 0 && !crashedObject) { crashedObject = true; throw new Error('object-crash'); } },
    }).migrate(), /object-crash/);
    assert.equal(JSON.parse(await readFile(join(stateDir, '.migration', 'v1-to-v2', 'progress.json'), 'utf8')).next_index, 1);

    await assert.rejects(new StateMigrationService({
      stateDir,
      afterManifest: async () => { throw new Error('manifest-crash'); },
    }).migrate(), /manifest-crash/);
    await assert.rejects(readFile(join(stateDir, '.migration', 'v1-to-v2', 'receipt.json'), 'utf8'), { code: 'ENOENT' });

    const recovered = await new StateMigrationService({ stateDir }).migrate();
    assert.equal(recovered.status, 'recovered_v2');
    assert.equal(JSON.parse(await readFile(join(stateDir, '.migration', 'v1-to-v2', 'receipt.json'), 'utf8')).verified_objects, 2);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
