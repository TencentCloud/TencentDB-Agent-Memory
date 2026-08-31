import { sha256 } from './hash.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSessionLock, writeJsonAtomically } from './atomic-file.js';
import { validateArchiveMetadata } from './state-validation.js';

const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

export function createForceArchiveOperationId({ sessionId, archiveGeneration, lastSuccessfulCaptureId, adapterVersion = 'kiro-memory-phase2' } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(archiveGeneration) || archiveGeneration < 0
    || (lastSuccessfulCaptureId !== null && typeof lastSuccessfulCaptureId !== 'string')) throw new Error('Invalid archive operation input');
  return `op_sha256_${sha256(canonical({
    adapter_version: adapterVersion,
    operation_type: 'force_archive',
    session_id: sessionId,
    archive_generation: archiveGeneration,
    last_successful_capture_id: lastSuccessfulCaptureId,
  }))}`;
}

export class ArchiveService {
  constructor({ config, turnStore, outbox, now = () => new Date() } = {}) {
    this.config = config;
    this.turnStore = turnStore;
    this.outbox = outbox;
    this.now = now;
  }

  async considerIdle({ sessionId, lastSuccessfulAppendAt, lastSuccessfulCaptureId = null, archiveGeneration = 0 } = {}) {
    const input = { sessionId, lastSuccessfulAppendAt, lastSuccessfulCaptureId, archiveGeneration };
    if (typeof this.config?.stateDir !== 'string' || typeof sessionId !== 'string' || !sessionId) return this.considerIdleUnlocked(input);
    return withSessionLock(this.metadataLockPath(sessionId), async () => this.considerIdleUnlocked(input));
  }

  async considerIdleUnlocked({ sessionId, lastSuccessfulAppendAt, lastSuccessfulCaptureId = null, archiveGeneration = 0 } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || typeof lastSuccessfulAppendAt !== 'string') return false;
    const appendTime = Date.parse(lastSuccessfulAppendAt);
    if (!Number.isFinite(appendTime) || this.now().getTime() - appendTime < 30 * 60 * 1000) return false;
    if (await this.turnStore.getActiveTurn(sessionId) !== null) return false;
    if (await this.outbox.hasPendingCaptureForSession(sessionId)) return false;
    const operationId = createForceArchiveOperationId({ sessionId, archiveGeneration, lastSuccessfulCaptureId });
    const enqueued = await this.outbox.enqueueOperation({
      operation_id: operationId,
      operation_type: 'force_archive',
      session_id: sessionId,
      archive_generation: archiveGeneration,
      last_successful_capture_id: lastSuccessfulCaptureId,
      payload: { sessionId, reason: 'kiro_idle_30m', ...(lastSuccessfulCaptureId ? { taskId: lastSuccessfulCaptureId } : {}) },
    });
    if (enqueued === null && typeof this.outbox.getMarker === 'function') {
      const marker = await this.outbox.getMarker(operationId);
      if (marker?.operation_type === 'force_archive' && marker.operation_id === operationId) {
        await this.recordForceOutcomeUnlocked({ sessionId, archiveGeneration, response: marker.result });
        return false;
      }
    }
    return true;
  }

  async considerSessionIdle(sessionId) {
    return withSessionLock(this.metadataLockPath(sessionId), async () => {
      const metadata = await this.readMetadata(sessionId);
      if (metadata.last_successful_append_at === null) return false;
      return this.considerIdleUnlocked({
        sessionId,
        lastSuccessfulAppendAt: metadata.last_successful_append_at,
        lastSuccessfulCaptureId: metadata.last_successful_capture_id,
        archiveGeneration: metadata.archive_generation,
      });
    });
  }

  metadataPath(sessionId) {
    return join(this.config.stateDir, 'sessions', sha256(sessionId), 'archive.json');
  }

  metadataLockPath(sessionId) {
    return join(this.config.stateDir, 'sessions', sha256(sessionId), '.archive-state.lock');
  }

  async readMetadata(sessionId) {
    try {
      const value = JSON.parse(await readFile(this.metadataPath(sessionId), 'utf8'));
      if (!validateArchiveMetadata(value, sha256(sessionId))) throw new Error('invalid');
      return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Archive metadata is invalid');
      return {
        version: 1,
        session_hash: `sha256:${sha256(sessionId)}`,
        last_successful_append_at: null,
        last_successful_capture_id: null,
        last_archive_at: null,
        archive_generation: 0,
      };
    }
  }

  async isForceOperationCurrent(item) {
    if (item?.operation_type !== 'force_archive' || typeof item.session_id !== 'string') return true;
    const metadata = await this.readMetadata(item.session_id);
    return metadata.last_successful_append_at !== null
      && metadata.archive_generation === item.archive_generation
      && metadata.last_successful_capture_id === item.last_successful_capture_id;
  }

  async recordCaptureOutcome({ sessionId, captureId, response } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || typeof captureId !== 'string') throw new Error('Invalid archive outcome');
    let cancelGeneration = null;
    const next = await withSessionLock(this.metadataLockPath(sessionId), async () => {
      const metadata = await this.readMetadata(sessionId);
      if (metadata.last_successful_capture_id === captureId) return metadata;
      const next = {
        ...metadata,
        last_successful_append_at: this.now().toISOString(),
        last_successful_capture_id: captureId,
      };
      if (response?.status === 'archived' && response.archived
        && Number.isSafeInteger(response.archived.archived_at_ms) && response.archived.archived_at_ms >= 0) {
        cancelGeneration = metadata.archive_generation;
        next.last_archive_at = new Date(response.archived.archived_at_ms).toISOString();
        next.archive_generation = metadata.archive_generation + 1;
        next.last_successful_append_at = null;
      }
      await writeJsonAtomically(this.metadataPath(sessionId), next);
      return next;
    });
    if (cancelGeneration !== null) await this.outbox.cancelForceOperations(sessionId, cancelGeneration);
    return next;
  }

  async recordForceOutcome({ sessionId, archiveGeneration, response } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(archiveGeneration) || archiveGeneration < 0
      || !['empty', 'archived'].includes(response?.status)) throw new Error('Invalid force archive outcome');
    return withSessionLock(this.metadataLockPath(sessionId), async () => this.recordForceOutcomeUnlocked({ sessionId, archiveGeneration, response }));
  }

  async recordForceOutcomeUnlocked({ sessionId, archiveGeneration, response }) {
    const metadata = await this.readMetadata(sessionId);
    if (metadata.archive_generation !== archiveGeneration) return metadata;
    const next = { ...metadata, last_successful_append_at: null };
    if (response.status === 'archived') {
      if (!Number.isSafeInteger(response.archived_at_ms) || response.archived_at_ms < 0) throw new Error('Invalid force archive outcome');
      next.last_archive_at = new Date(response.archived_at_ms).toISOString();
      next.archive_generation = archiveGeneration + 1;
    }
    await writeJsonAtomically(this.metadataPath(sessionId), next);
    return next;
  }
}
