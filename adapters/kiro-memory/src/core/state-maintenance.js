import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateKnownStateObject } from './state-validation.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rel = (root, path) => relative(root, path).split(sep).join('/');

export class StateMaintenanceService {
  constructor({ stateDir, now = () => new Date(), maxObjects = 10000, archiveService } = {}) {
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('Invalid state root');
    this.stateDir = resolve(stateDir);
    this.now = now;
    this.maxObjects = maxObjects;
    this.archiveService = archiveService;
  }

  pathFor(relativePath) {
    const path = resolve(this.stateDir, ...relativePath.split('/'));
    if (path !== this.stateDir && !path.startsWith(`${this.stateDir}${sep}`)) throw new Error('Maintenance path escapes state root');
    return path;
  }

  async plan() {
    const items = [];
    const activeTurnPaths = new Set();
    const parsedValues = new Map();
    const outboxIds = new Set();
    const capturedIds = new Set();
    const turnIds = new Set();
    let truncated = false;
    const visit = async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (items.length >= this.maxObjects) { truncated = true; return; }
        const path = join(directory, entry.name);
        const relativePath = rel(this.stateDir, path);
        if (relativePath === '.maintenance-quarantine' || relativePath.startsWith('.maintenance-quarantine/')) continue;
        const stat = await lstat(path);
        if (entry.isDirectory()) {
          items.push({ path: relativePath, identifier: `sha256:${sha256(relativePath)}`, object_kind: 'directory', size: stat.size, mtime_ms: stat.mtimeMs, sha256: null, category: 'directory', action: 'report' });
          await visit(path);
          if (truncated) return;
          continue;
        }
        if (!entry.isFile()) {
          items.push({ path: relativePath, identifier: `sha256:${sha256(relativePath)}`, object_kind: 'special', size: stat.size, mtime_ms: stat.mtimeMs, sha256: null, category: 'special_object', action: 'report' });
          continue;
        }
        const source = await readFile(path);
        let category = 'regular_file';
        let action = 'retain';
        if (entry.name.endsWith('.lock')) { category = 'session_lock'; action = 'report'; }
        else if (entry.name.endsWith('.json')) {
          let value;
          try { value = JSON.parse(source.toString('utf8')); }
          catch { category = 'corrupt_json'; action = 'quarantine'; }
          const stateValidity = value === undefined ? null : validateKnownStateObject(relativePath, value);
          const invalidState = stateValidity === false;
          if (value !== undefined && !invalidState) parsedValues.set(relativePath, value);
          if (!invalidState && value && entry.name === 'active.json' && typeof value.active_turn_id === 'string' && value.active_turn_id.length > 0) {
            activeTurnPaths.add(`${rel(this.stateDir, directory)}/turns/${encodeURIComponent(value.active_turn_id)}.json`);
          }
          if (!invalidState && value && relativePath.startsWith('sessions/') && relativePath.includes('/turns/') && typeof value.turn_id === 'string') turnIds.add(value.turn_id);
          if (!invalidState && relativePath.startsWith('outbox/')) outboxIds.add(entry.name.slice(0, -5));
          if (!invalidState && relativePath.startsWith('captured/')) capturedIds.add(entry.name.slice(0, -5));
          if (Number.isInteger(value?.version) && value.version > 2) { category = 'future_version'; action = 'report'; }
          else if (invalidState) { category = 'invalid_state'; action = 'quarantine'; }
          else if (value && relativePath.startsWith('outbox/')) {
            category = value.manual_review === true ? 'manual_review_outbox' : 'pending_outbox';
            action = 'retain';
          } else if (value?.lifecycle_status === 'pending' && Date.parse(value.created_at) <= this.now().getTime() - 24 * 60 * 60 * 1000) {
            if (activeTurnPaths.has(relativePath)) { category = 'active_pending_turn'; action = 'retain'; }
            else { category = 'old_pending_turn'; action = 'quarantine'; }
          } else if (value?.lifecycle_status === 'completed'
            && ['partial_captured', 'full_captured', 'skipped_no_observable_data'].includes(value.capture_status)
            && Date.parse(value.completed_at) <= this.now().getTime() - 30 * 24 * 60 * 60 * 1000) {
            category = 'old_completed_turn'; action = 'quarantine';
          }
        }
        items.push({ path: relativePath, identifier: `sha256:${sha256(relativePath)}`, object_kind: 'regular', size: stat.size, mtime_ms: stat.mtimeMs, sha256: sha256(source), category, action });
      }
    };
    await visit(this.stateDir);
    for (const item of items) {
      const value = parsedValues.get(item.path);
      const fileName = item.path.slice(item.path.lastIndexOf('/') + 1);
      const objectId = fileName.endsWith('.json') ? fileName.slice(0, -5) : null;
      if (item.path.startsWith('outbox/') && capturedIds.has(objectId)) {
        item.category = 'redundant_success_outbox'; item.action = 'quarantine';
      } else if (item.path.startsWith('captured/') && item.action === 'retain') {
        const timestamp = value?.completed_at ?? value?.captured_at;
        const old = typeof timestamp === 'string' && Date.parse(timestamp) <= this.now().getTime() - 30 * 24 * 60 * 60 * 1000;
        const related = outboxIds.has(objectId) || (typeof value?.turn_id === 'string' && turnIds.has(value.turn_id));
        if (old && !related) { item.category = 'orphan_marker'; item.action = 'quarantine'; }
      }
      if (item.category === 'old_pending_turn' && activeTurnPaths.has(item.path)) {
        item.category = 'active_pending_turn'; item.action = 'retain';
      }
    }
    const planId = sha256(JSON.stringify(items.map(({ path, size, mtime_ms: mtime, sha256: digest, action }) => ({ path, size, mtime, digest, action }))));
    return { version: 1, plan_id: `sha256:${planId}`, created_at: this.now().toISOString(), truncated, items };
  }

  async apply(plan) {
    if (!plan || plan.version !== 1 || !Array.isArray(plan.items)) throw new Error('Invalid maintenance plan');
    if (plan.truncated) throw new Error('Cannot apply incomplete maintenance plan');
    let quarantined = 0;
    let skipped = 0;
    for (const item of plan.items.filter((candidate) => candidate.action === 'quarantine')) {
      const sourcePath = this.pathFor(item.path);
      let stat;
      let source;
      try { stat = await lstat(sourcePath); source = await readFile(sourcePath); }
      catch { skipped += 1; continue; }
      if (!stat.isFile() || stat.size !== item.size || stat.mtimeMs !== item.mtime_ms || sha256(source) !== item.sha256) {
        skipped += 1; continue;
      }
      const destination = join(this.stateDir, '.maintenance-quarantine', plan.plan_id.slice(7), ...item.path.split('/'));
      await mkdir(resolve(destination, '..'), { recursive: true });
      try { await lstat(destination); skipped += 1; continue; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await rename(sourcePath, destination);
      if (!(await lstat(destination)).isFile()) throw new Error('Quarantine verification failed');
      quarantined += 1;
    }
    let idleArchivesEnqueued = 0;
    if (this.archiveService?.considerSessionIdle) {
      for (const sessionId of await this.discoverArchiveSessionIds()) {
        if (await this.archiveService.considerSessionIdle(sessionId)) idleArchivesEnqueued += 1;
      }
    }
    return { quarantined, skipped, idleArchivesEnqueued };
  }

  async discoverArchiveSessionIds() {
    let sessions;
    try { sessions = await readdir(join(this.stateDir, 'sessions'), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const result = [];
    let scanned = 0;
    for (const sessionEntry of sessions.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!sessionEntry.isDirectory() || !/^[a-f0-9]{64}$/.test(sessionEntry.name)) continue;
      const sessionDirectory = join(this.stateDir, 'sessions', sessionEntry.name);
      let archive;
      try {
        if (!(await lstat(join(sessionDirectory, 'archive.json'))).isFile()) continue;
        archive = JSON.parse(await readFile(join(sessionDirectory, 'archive.json'), 'utf8'));
      } catch { continue; }
      if (archive?.version !== 1 || archive.session_hash !== `sha256:${sessionEntry.name}`) continue;
      let turns;
      try { turns = await readdir(join(sessionDirectory, 'turns'), { withFileTypes: true }); }
      catch { continue; }
      for (const turnEntry of turns.sort((a, b) => a.name.localeCompare(b.name))) {
        if (scanned >= this.maxObjects) return result;
        scanned += 1;
        if (!turnEntry.isFile() || !turnEntry.name.endsWith('.json')) continue;
        try {
          const turn = JSON.parse(await readFile(join(sessionDirectory, 'turns', turnEntry.name), 'utf8'));
          if (typeof turn.session_id === 'string' && sha256(turn.session_id) === sessionEntry.name) {
            result.push(turn.session_id);
            break;
          }
        } catch { /* corrupt turns are handled by the maintenance plan */ }
      }
    }
    return result;
  }
}
