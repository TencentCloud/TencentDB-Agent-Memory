import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { writeJsonAtomically } from './atomic-file.js';
import { validateKnownStateObject } from './state-validation.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalizedRelative = (root, path) => relative(root, path).split(sep).join('/');

export class StateMigrationService {
  constructor({ stateDir, now = () => new Date(), afterPlan = async () => {}, afterObject = async () => {}, afterManifest = async () => {} } = {}) {
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('Invalid state root');
    this.stateDir = resolve(stateDir);
    this.now = now;
    this.afterPlan = afterPlan;
    this.afterObject = afterObject;
    this.afterManifest = afterManifest;
    this.journalDir = join(this.stateDir, '.migration', 'v1-to-v2');
  }

  async readJson(path, missing = null) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return missing; throw new Error('Migration journal is invalid'); }
  }

  async scan(directory = this.stateDir, objects = []) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return objects; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = normalizedRelative(this.stateDir, path);
      if (rel === 'state.json' || rel === '.migration' || rel.startsWith('.migration/')) continue;
      if (entry.isDirectory()) await this.scan(path, objects);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (objects.length >= 10000) throw new Error('Migration scan limit exceeded');
        const source = await readFile(path);
        let value;
        try { value = JSON.parse(source.toString('utf8')); }
        catch { throw new Error('Migration source is invalid'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Migration source is invalid');
        if (Number.isInteger(value.version) && value.version > 2) throw new Error('Unknown future state version');
        if (validateKnownStateObject(rel, value) === false) throw new Error('Migration source is invalid');
        const stat = await lstat(path);
        objects.push({ path: rel, size: stat.size, mtime_ms: stat.mtimeMs, sha256: hash(source) });
      }
    }
    return objects;
  }

  pathFor(relativePath) {
    const path = resolve(this.stateDir, ...relativePath.split('/'));
    if (path !== this.stateDir && !path.startsWith(`${this.stateDir}${sep}`)) throw new Error('Migration path escapes state root');
    return path;
  }

  async migrate() {
    const manifestPath = join(this.stateDir, 'state.json');
    const manifest = await this.readJson(manifestPath);
    if (manifest?.version > 2) throw new Error('Unknown future state version');
    const planPath = join(this.journalDir, 'plan.json');
    let plan = await this.readJson(planPath);
    if (manifest?.version === 2) {
      const receiptPath = join(this.journalDir, 'receipt.json');
      const receipt = await this.readJson(receiptPath);
      if (plan === null) return { status: 'already_v2' };
      if (plan.version !== 1 || plan.migration !== 'v1-to-v2' || !Array.isArray(plan.objects)) throw new Error('Migration journal is invalid');
      const progress = await this.readJson(join(this.journalDir, 'progress.json'), { version: 1, next_index: 0 });
      if (progress.version !== 1 || progress.next_index !== plan.objects.length) throw new Error('Migration journal is invalid');
      if (receipt !== null) {
        if (receipt.version !== 1 || receipt.migration !== 'v1-to-v2' || receipt.verified_objects !== plan.objects.length) throw new Error('Migration journal is invalid');
        return { status: 'already_v2' };
      }
      await writeJsonAtomically(receiptPath, {
        version: 1, migration: 'v1-to-v2', completed_at: manifest.created_at, verified_objects: plan.objects.length,
      });
      return { status: 'recovered_v2', verifiedObjects: plan.objects.length };
    }

    if (plan === null) {
      plan = { version: 1, migration: 'v1-to-v2', objects: await this.scan() };
      await writeJsonAtomically(planPath, plan);
    } else if (plan.version !== 1 || plan.migration !== 'v1-to-v2' || !Array.isArray(plan.objects)) {
      throw new Error('Migration journal is invalid');
    }
    await this.afterPlan();

    const progressPath = join(this.journalDir, 'progress.json');
    const existingProgress = await this.readJson(progressPath, { version: 1, next_index: 0 });
    if (existingProgress.version !== 1 || !Number.isInteger(existingProgress.next_index)
      || existingProgress.next_index < 0 || existingProgress.next_index > plan.objects.length) throw new Error('Migration journal is invalid');
    for (let index = existingProgress.next_index; index < plan.objects.length; index += 1) {
      const expected = plan.objects[index];
      const path = this.pathFor(expected.path);
      const stat = await lstat(path);
      const source = await readFile(path);
      if (!stat.isFile() || stat.size !== expected.size || stat.mtimeMs !== expected.mtime_ms || hash(source) !== expected.sha256) {
        throw new Error('Migration source changed');
      }
      await writeJsonAtomically(progressPath, { version: 1, next_index: index + 1 });
      await this.afterObject(index);
    }

    const createdAt = this.now().toISOString();
    await writeJsonAtomically(manifestPath, { version: 2, adapter: 'kiro-memory', created_at: createdAt });
    await this.afterManifest();
    await writeJsonAtomically(join(this.journalDir, 'receipt.json'), {
      version: 1, migration: 'v1-to-v2', completed_at: createdAt, verified_objects: plan.objects.length,
    });
    return { status: 'migrated', verifiedObjects: plan.objects.length };
  }
}
