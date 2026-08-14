import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { withSessionLock, writeJsonAtomically } from './atomic-file.js';

const CAPTURE_ID = /^cap_sha256_[a-f0-9]{64}$/;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export class OutboxError extends Error {
  constructor(message, { corrupt = false } = {}) { super(message); this.name = 'OutboxError'; this.corrupt = corrupt; }
}

const corrupt = () => new OutboxError('Outbox item is invalid', { corrupt: true });
const assertCaptureId = (captureId) => { if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) throw new OutboxError('Invalid capture id'); };
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const validMessage = (message, index, messages) => {
  if (index === 0) return exactKeys(message, ['role', 'content']) && message.role === 'user' && typeof message.content === 'string';
  if (!exactKeys(message, ['role', 'tool_name', 'tool_call_id', 'content']) || !['tool_call', 'tool_result'].includes(message.role) || !nonEmpty(message.tool_name) || !nonEmpty(message.tool_call_id) || typeof message.content !== 'string') return false;
  if (index % 2 === 1) return message.role === 'tool_call';
  const call = messages[index - 1];
  return message.role === 'tool_result' && message.tool_name === call.tool_name && message.tool_call_id === call.tool_call_id;
};
const validPayload = (payload) => exactKeys(payload, ['session_id', 'team_id', 'user_id', 'agent_id', 'task_id', 'messages'])
  && ['session_id', 'team_id', 'user_id', 'agent_id', 'task_id'].every((key) => nonEmpty(payload[key]))
  && Array.isArray(payload.messages) && payload.messages.length >= 3 && payload.messages.length % 2 === 1
  && payload.messages.every(validMessage);
const validItem = (item) => exactKeys(item, ['version', 'capture_id', 'type', 'session_id', 'turn_id', 'created_at', 'attempt_count', 'next_retry_at', 'payload'])
  && item.version === 1 && CAPTURE_ID.test(item.capture_id) && item.type === 'skill_conversation'
  && nonEmpty(item.session_id) && nonEmpty(item.turn_id) && iso(item.created_at)
  && Number.isInteger(item.attempt_count) && item.attempt_count >= 0 && (item.next_retry_at === null || iso(item.next_retry_at))
  && validPayload(item.payload) && item.payload.session_id === item.session_id && item.payload.task_id === item.turn_id;
const markerFor = (item, now) => ({ version: 1, capture_id: item.capture_id, captured_at: now().toISOString(), type: item.type, session_id: item.session_id, turn_id: item.turn_id });

export class Outbox {
  constructor({ stateDir, gatewayClient, now = () => new Date(), monotonicNow = () => Date.now(), lockTimeoutMs, lockRetryMs } = {}) {
    if (!nonEmpty(stateDir)) throw new OutboxError('Invalid state directory');
    this.stateDir = stateDir; this.gatewayClient = gatewayClient; this.now = now; this.monotonicNow = monotonicNow;
    this.lockOptions = { ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }), ...(lockRetryMs === undefined ? {} : { retryMs: lockRetryMs }) };
  }

  outboxPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'outbox', `${captureId}.json`); }
  markerPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'captured', `${captureId}.json`); }
  lockPath(captureId) { assertCaptureId(captureId); return join(this.stateDir, 'outbox', '.locks', `${captureId}.lock`); }
  remaining(deadline) { return Math.max(0, deadline - this.monotonicNow()); }

  async enqueue(envelope) {
    const item = this.toNewItem(envelope);
    return this.withLock(item.capture_id, async () => {
      if (await this.hasMarkerUnlocked(item.capture_id)) return null;
      const existing = await this.readItemUnlocked(item.capture_id, true);
      if (existing !== null) return existing;
      await this.persist(() => this.writeItem(item)); return item;
    });
  }

  async hasMarker(captureId) { assertCaptureId(captureId); return this.hasMarkerUnlocked(captureId); }
  async writeMarker(envelope) { const item = this.toNewItem(envelope); return this.withLock(item.capture_id, async () => this.persist(() => this.writeMarkerUnlocked(item))); }

  async flush({ maxItems = 3, budgetMs = 1_500 } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3 || !Number.isFinite(budgetMs) || budgetMs < 0) throw new OutboxError('Invalid flush options');
    const result = { processed: 0, acknowledged: 0, deferred: 0, failed: 0 };
    const deadline = this.monotonicNow() + budgetMs;
    const items = await this.listItems(deadline);
    for (const item of items) {
      if (result.processed >= maxItems || this.remaining(deadline) <= 0) { result.deferred += 1; continue; }
      if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) { result.deferred += 1; continue; }
      result.processed += 1;
      try {
        const outcome = await this.process(item.capture_id, deadline);
        if (outcome === 'acknowledged') result.acknowledged += 1;
        else if (outcome === 'failed') result.failed += 1;
        else if (outcome === 'deferred') result.deferred += 1;
      } catch (error) {
        if (error instanceof OutboxError && error.corrupt) { result.failed += 1; continue; }
        throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed');
      }
    }
    return result;
  }

  toNewItem(envelope) {
    if (!isObject(envelope)) throw new OutboxError('Invalid outbox item');
    const { capture_id: captureId, type, session_id: sessionId, turn_id: turnId, payload } = envelope;
    assertCaptureId(captureId);
    const item = { version: 1, capture_id: captureId, type, session_id: sessionId, turn_id: turnId, created_at: this.now().toISOString(), attempt_count: 0, next_retry_at: null, payload };
    if (!validItem(item)) throw new OutboxError('Invalid outbox item');
    return item;
  }

  async process(captureId, deadline) {
    if (this.remaining(deadline) <= 0) return 'deferred';
    let lockResult;
    try { lockResult = await this.withLockUntil(captureId, deadline, async () => this.processLocked(captureId, deadline)); }
    catch (error) { if (this.remaining(deadline) <= 0) return 'deferred'; throw error; }
    return lockResult;
  }

  async processLocked(captureId, deadline) {
    if (this.remaining(deadline) <= 0) return 'deferred';
    if (await this.hasMarkerUnlocked(captureId)) {
      if (this.remaining(deadline) > 0) await this.persist(() => this.deleteItem(captureId));
      return 'acknowledged';
    }
    if (this.remaining(deadline) <= 0) return 'deferred';
    const item = await this.readItemUnlocked(captureId, true);
    if (item === null) return 'deferred';
    if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) return 'deferred';
    const gatewayOutcome = await this.callGateway(item, deadline);
    if (gatewayOutcome === 'deadline') return 'deferred';
    if (gatewayOutcome === 'failed') {
      if (this.remaining(deadline) <= 0) return 'deferred';
      const delay = BACKOFF_MS[Math.min(item.attempt_count, BACKOFF_MS.length - 1)];
      await this.persist(() => this.writeItem({ ...item, attempt_count: item.attempt_count + 1, next_retry_at: new Date(this.now().getTime() + delay).toISOString() }));
      return 'failed';
    }
    if (this.remaining(deadline) <= 0) return 'deferred';
    await this.persist(() => this.writeMarkerUnlocked(item));
    if (this.remaining(deadline) > 0) await this.persist(() => this.deleteItem(captureId));
    return 'acknowledged';
  }

  async callGateway(item, deadline) {
    const timeoutMs = this.remaining(deadline);
    if (timeoutMs <= 0) return 'deadline';
    if (!this.gatewayClient || typeof this.gatewayClient.skillConversationAdd !== 'function') return 'failed';
    let timer;
    const call = Promise.resolve().then(() => this.gatewayClient.skillConversationAdd(item.payload, { timeoutMs }));
    const settled = call.then(() => 'ok', () => 'failed');
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), timeoutMs); });
    try { return await Promise.race([settled, timedOut]); } finally { clearTimeout(timer); }
  }

  async listItems(deadline) {
    if (this.remaining(deadline) <= 0) return [];
    let entries;
    try { entries = await readdir(join(this.stateDir, 'outbox'), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw new OutboxError('Outbox persistence failed'); }
    const items = [];
    for (const entry of entries) {
      if (this.remaining(deadline) <= 0) break;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const captureId = entry.name.slice(0, -5); if (!CAPTURE_ID.test(captureId)) continue;
      try { const item = await this.readItemUnlocked(captureId); if (item !== null) items.push(item); }
      catch (error) { if (!(error instanceof OutboxError) || !error.corrupt) throw error; }
    }
    return items.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.capture_id.localeCompare(right.capture_id));
  }

  async readItemUnlocked(captureId, missingOk = false) {
    let source;
    try { source = await readFile(this.outboxPath(captureId), 'utf8'); }
    catch (error) { if (missingOk && error?.code === 'ENOENT') return null; throw new OutboxError('Outbox persistence failed'); }
    let item; try { item = JSON.parse(source); } catch { throw corrupt(); }
    if (!validItem(item) || item.capture_id !== captureId) throw corrupt(); return item;
  }

  async hasMarkerUnlocked(captureId) {
    let source;
    try { source = await readFile(this.markerPath(captureId), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw new OutboxError('Outbox persistence failed'); }
    let marker; try { marker = JSON.parse(source); } catch { throw corrupt(); }
    if (!exactKeys(marker, ['version', 'capture_id', 'captured_at', 'type', 'session_id', 'turn_id']) || marker.version !== 1 || marker.capture_id !== captureId || marker.type !== 'skill_conversation' || !iso(marker.captured_at) || !nonEmpty(marker.session_id) || !nonEmpty(marker.turn_id)) throw corrupt();
    return true;
  }

  async writeItem(item) { await writeJsonAtomically(this.outboxPath(item.capture_id), item); }
  async writeMarkerUnlocked(item) { await writeJsonAtomically(this.markerPath(item.capture_id), markerFor(item, this.now)); }
  async deleteItem(captureId) { await rm(this.outboxPath(captureId), { force: true }); }
  async persist(operation) { try { return await operation(); } catch (error) { throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed'); } }
  async withLock(captureId, operation, options = {}) { try { return await withSessionLock(this.lockPath(captureId), operation, { ...this.lockOptions, ...options }); } catch (error) { throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed'); } }
  async withLockUntil(captureId, deadline, operation) {
    const remaining = Math.floor(this.remaining(deadline)); if (remaining <= 0) return 'deferred';
    return this.withLock(captureId, operation, { timeoutMs: remaining, retryMs: Math.max(1, Math.min(20, remaining)) });
  }
}
