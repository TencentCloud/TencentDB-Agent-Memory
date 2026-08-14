import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { withSessionLock, writeJsonAtomically } from './atomic-file.js';

const CAPTURE_ID = /^cap_sha256_[a-f0-9]{64}$/;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export class OutboxError extends Error {
  constructor(message) { super(message); this.name = 'OutboxError'; }
}

const assertCaptureId = (captureId) => {
  if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) throw new OutboxError('Invalid capture id');
};

const validPayload = (payload) => isObject(payload)
  && typeof payload.session_id === 'string' && typeof payload.task_id === 'string'
  && typeof payload.team_id === 'string' && typeof payload.user_id === 'string'
  && typeof payload.agent_id === 'string' && Array.isArray(payload.messages);

const validItem = (item) => isObject(item)
  && Object.keys(item).length === 9
  && item.version === 1 && CAPTURE_ID.test(item.capture_id)
  && item.type === 'skill_conversation'
  && typeof item.session_id === 'string' && item.session_id.length > 0
  && typeof item.turn_id === 'string' && item.turn_id.length > 0
  && iso(item.created_at) && Number.isInteger(item.attempt_count) && item.attempt_count >= 0
  && (item.next_retry_at === null || iso(item.next_retry_at))
  && validPayload(item.payload);

const markerFor = (item, now) => ({
  version: 1,
  capture_id: item.capture_id,
  captured_at: now().toISOString(),
  type: item.type,
  session_id: item.session_id,
  turn_id: item.turn_id,
});

export class Outbox {
  constructor({ stateDir, gatewayClient, now = () => new Date(), monotonicNow = () => Date.now(), lockTimeoutMs, lockRetryMs } = {}) {
    if (typeof stateDir !== 'string' || stateDir.length === 0) throw new OutboxError('Invalid state directory');
    this.stateDir = stateDir;
    this.gatewayClient = gatewayClient;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.lockOptions = { ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }), ...(lockRetryMs === undefined ? {} : { retryMs: lockRetryMs }) };
  }

  outboxPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'outbox', `${captureId}.json`); }
  markerPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'captured', `${captureId}.json`); }
  lockPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'outbox', '.locks', `${captureId}.lock`); }

  async enqueue(envelope) {
    const item = this.toNewItem(envelope);
    return this.withLock(item.capture_id, async () => {
      if (await this.hasMarkerUnlocked(item.capture_id)) return null;
      const existing = await this.readItemUnlocked(item.capture_id, true);
      if (existing !== null) return existing;
      await this.writeItem(item);
      return item;
    });
  }

  async hasMarker(captureId) { assertCaptureId(captureId); return this.hasMarkerUnlocked(captureId); }

  async writeMarker(envelope) {
    const item = this.toNewItem(envelope);
    return this.withLock(item.capture_id, async () => this.writeMarkerUnlocked(item));
  }

  async flush({ maxItems = 3, budgetMs = 1_500 } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3 || !Number.isFinite(budgetMs) || budgetMs < 0) {
      throw new OutboxError('Invalid flush options');
    }
    const result = { processed: 0, acknowledged: 0, deferred: 0, failed: 0 };
    const startedAt = this.monotonicNow();
    const items = await this.listItems();
    for (const item of items) {
      if (result.processed >= maxItems || this.monotonicNow() - startedAt >= budgetMs) break;
      if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) { result.deferred += 1; continue; }
      result.processed += 1;
      try {
        const outcome = await this.process(item.capture_id);
        if (outcome === 'acknowledged') result.acknowledged += 1;
        else if (outcome === 'failed') result.failed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  toNewItem(envelope) {
    if (!isObject(envelope)) throw new OutboxError('Invalid outbox item');
    const { capture_id: captureId, type, session_id: sessionId, turn_id: turnId, payload } = envelope;
    assertCaptureId(captureId);
    if (type !== 'skill_conversation' || typeof sessionId !== 'string' || sessionId.length === 0 || typeof turnId !== 'string' || turnId.length === 0 || !validPayload(payload)) {
      throw new OutboxError('Invalid outbox item');
    }
    const item = { version: 1, capture_id: captureId, type, session_id: sessionId, turn_id: turnId, created_at: this.now().toISOString(), attempt_count: 0, next_retry_at: null, payload };
    if (!validItem(item)) throw new OutboxError('Invalid outbox item');
    return item;
  }

  async process(captureId) {
    return this.withLock(captureId, async () => {
      if (await this.hasMarkerUnlocked(captureId)) {
        await rm(this.outboxPath(captureId), { force: true });
        return 'acknowledged';
      }
      const item = await this.readItemUnlocked(captureId, true);
      if (item === null) return 'skipped';
      if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) return 'deferred';
      try {
        if (!this.gatewayClient || typeof this.gatewayClient.skillConversationAdd !== 'function') throw new Error('gateway');
        await this.gatewayClient.skillConversationAdd(item.payload);
      } catch {
        const delay = BACKOFF_MS[Math.min(item.attempt_count, BACKOFF_MS.length - 1)];
        await this.writeItem({ ...item, attempt_count: item.attempt_count + 1, next_retry_at: new Date(this.now().getTime() + delay).toISOString() });
        return 'failed';
      }
      await this.writeMarkerUnlocked(item);
      await rm(this.outboxPath(captureId), { force: true });
      return 'acknowledged';
    });
  }

  async listItems() {
    let entries;
    try { entries = await readdir(join(this.stateDir, 'outbox'), { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw new OutboxError('Outbox read failed'); }
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const captureId = entry.name.slice(0, -5);
      if (!CAPTURE_ID.test(captureId)) continue;
      try { const item = await this.readItemUnlocked(captureId); if (item !== null) items.push(item); } catch { /* corrupted items are isolated */ }
    }
    return items.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.capture_id.localeCompare(right.capture_id));
  }

  async readItemUnlocked(captureId, missingOk = false) {
    try {
      const item = JSON.parse(await readFile(this.outboxPath(captureId), 'utf8'));
      if (!validItem(item) || item.capture_id !== captureId) throw new OutboxError('Outbox item is invalid');
      return item;
    } catch (error) {
      if (missingOk && error?.code === 'ENOENT') return null;
      if (error instanceof OutboxError) throw error;
      throw new OutboxError('Outbox item is invalid');
    }
  }

  async hasMarkerUnlocked(captureId) {
    try {
      const marker = JSON.parse(await readFile(this.markerPath(captureId), 'utf8'));
      return isObject(marker) && marker.version === 1 && marker.capture_id === captureId && marker.type === 'skill_conversation' && iso(marker.captured_at) && typeof marker.session_id === 'string' && typeof marker.turn_id === 'string';
    } catch (error) { if (error?.code === 'ENOENT') return false; throw new OutboxError('Capture marker is invalid'); }
  }

  async writeItem(item) { await writeJsonAtomically(this.outboxPath(item.capture_id), item); }
  async writeMarkerUnlocked(item) { await writeJsonAtomically(this.markerPath(item.capture_id), markerFor(item, this.now)); }
  async withLock(captureId, operation) { return withSessionLock(this.lockPath(captureId), operation, this.lockOptions); }
}
