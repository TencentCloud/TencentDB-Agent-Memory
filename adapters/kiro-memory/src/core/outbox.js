import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SessionLockTimeoutError, withSessionLock, writeJsonAtomically } from './atomic-file.js';
import { sha256 } from './hash.js';

const CAPTURE_ID = /^cap_sha256_[a-f0-9]{64}$/;
const OPERATION_ID = /^(?:cap|op)_sha256_[a-f0-9]{64}$/;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export class OutboxError extends Error {
  constructor(message, { corrupt = false } = {}) { super(message); this.name = 'OutboxError'; this.corrupt = corrupt; }
}

const corrupt = () => new OutboxError('Outbox item is invalid', { corrupt: true });
const assertCaptureId = (captureId) => { if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) throw new OutboxError('Invalid capture id'); };
const assertOperationId = (operationId) => { if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) throw new OutboxError('Invalid operation id'); };
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const validMessage = (message, index, messages) => {
  if (index === 0) return (exactKeys(message, ['role', 'content']) || exactKeys(message, ['role', 'content', 'timestamp']))
    && message.role === 'user' && typeof message.content === 'string'
    && (message.timestamp === undefined || iso(message.timestamp));
  if ((!exactKeys(message, ['role', 'tool_name', 'tool_call_id', 'content']) && !exactKeys(message, ['role', 'tool_name', 'tool_call_id', 'content', 'timestamp']))
    || !['tool_call', 'tool_result'].includes(message.role) || !nonEmpty(message.tool_name) || !nonEmpty(message.tool_call_id)
    || typeof message.content !== 'string' || (message.timestamp !== undefined && !iso(message.timestamp))) return false;
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
const validForcePayload = (payload) => isObject(payload)
  && Object.keys(payload).every((key) => ['sessionId', 'reason', 'taskId'].includes(key))
  && nonEmpty(payload.sessionId)
  && (payload.reason === undefined || nonEmpty(payload.reason))
  && (payload.taskId === undefined || nonEmpty(payload.taskId));
const validOperationItem = (item) => exactKeys(item, ['version', 'operation_id', 'operation_type', 'session_id', 'turn_id', 'archive_generation', 'last_successful_capture_id', 'created_at', 'attempt_count', 'next_retry_at', 'manual_review', 'payload'])
  && item.version === 2 && OPERATION_ID.test(item.operation_id) && ['force_archive', 'skill_conversation'].includes(item.operation_type)
  && nonEmpty(item.session_id)
  && (item.operation_type === 'force_archive' ? item.turn_id === null : nonEmpty(item.turn_id))
  && (item.operation_type === 'force_archive' ? Number.isInteger(item.archive_generation) && item.archive_generation >= 0 : item.archive_generation === null)
  && (item.last_successful_capture_id === null || CAPTURE_ID.test(item.last_successful_capture_id))
  && iso(item.created_at) && Number.isInteger(item.attempt_count) && item.attempt_count >= 0
  && (item.next_retry_at === null || iso(item.next_retry_at)) && typeof item.manual_review === 'boolean'
  && (item.operation_type === 'force_archive' ? validForcePayload(item.payload) && item.payload.sessionId === item.session_id
    : validPayload(item.payload) && item.payload.session_id === item.session_id && item.payload.task_id === item.turn_id);
const validAnyItem = (item) => validItem(item) || validOperationItem(item);
export const isValidOutboxItem = validAnyItem;
const idFor = (item) => item.version === 2 ? item.operation_id : item.capture_id;

export const isValidOutboxMarker = (marker, captureId) => {
  const validLegacy = exactKeys(marker, ['version', 'capture_id', 'captured_at', 'type', 'session_id', 'turn_id'])
    && marker.version === 1 && marker.capture_id === captureId && marker.type === 'skill_conversation'
    && iso(marker.captured_at) && nonEmpty(marker.session_id) && nonEmpty(marker.turn_id);
  const validV2Keys = marker?.operation_type === 'skill_conversation'
    ? exactKeys(marker, ['version', 'operation_id', 'completed_at', 'operation_type', 'session_id', 'turn_id', 'result'])
    : exactKeys(marker, ['version', 'operation_id', 'completed_at', 'operation_type', 'session_id', 'result']);
  const validV2 = validV2Keys && marker.version === 2 && marker.operation_id === captureId
    && ['force_archive', 'skill_conversation'].includes(marker.operation_type)
    && iso(marker.completed_at) && nonEmpty(marker.session_id) && isObject(marker.result)
    && (marker.operation_type !== 'skill_conversation' || nonEmpty(marker.turn_id))
    && (marker.operation_type !== 'force_archive' || ['empty', 'archived'].includes(marker.result.status));
  return validLegacy || validV2;
};

export class Outbox {
  constructor({ stateDir, gatewayClient, now = () => new Date(), monotonicNow = () => Date.now(), lockTimeoutMs, lockRetryMs, onAcknowledged = async () => {}, shouldProcess = async () => true } = {}) {
    if (!nonEmpty(stateDir)) throw new OutboxError('Invalid state directory');
    if (typeof onAcknowledged !== 'function') throw new OutboxError('Invalid acknowledgement handler');
    if (typeof shouldProcess !== 'function') throw new OutboxError('Invalid process guard');
    this.stateDir = stateDir; this.gatewayClient = gatewayClient; this.now = now; this.monotonicNow = monotonicNow;
    this.onAcknowledged = onAcknowledged;
    this.shouldProcess = shouldProcess;
    this.lockOptions = { ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }), ...(lockRetryMs === undefined ? {} : { retryMs: lockRetryMs }) };
  }

  outboxPath(operationId) { assertOperationId(operationId); return join(this.stateDir, 'outbox', `${operationId}.json`); }
  markerPath(operationId) { assertOperationId(operationId); return join(this.stateDir, 'captured', `${operationId}.json`); }
  lockPath(operationId) { assertOperationId(operationId); return join(this.stateDir, 'outbox', '.locks', `${operationId}.lock`); }
  deliveryLockPath(sessionId) {
    if (!nonEmpty(sessionId)) throw new OutboxError('Invalid session id');
    return join(this.stateDir, 'outbox', '.delivery-locks', `${sha256(sessionId)}.lock`);
  }
  remaining(deadline) { return Math.max(0, deadline - this.monotonicNow()); }

  async enqueue(envelope) {
    const item = this.toNewItem(envelope);
    return this.withLock(item.operation_id, async () => {
      if (await this.hasMarkerUnlocked(item.operation_id)) return null;
      const existing = await this.readItemUnlocked(item.operation_id, true);
      if (existing !== null) return existing;
      await this.persist(() => this.writeItem(item)); return item;
    });
  }

  async enqueueOperation(operation) {
    const item = this.toNewOperation(operation);
    return this.withLock(item.operation_id, async () => {
      if (await this.hasMarkerUnlocked(item.operation_id)) return null;
      const existing = await this.readItemUnlocked(item.operation_id, true);
      if (existing !== null) return existing;
      await this.persist(() => this.writeItem(item));
      return item;
    });
  }

  async hasMarker(operationId) { assertOperationId(operationId); return this.hasMarkerUnlocked(operationId); }
  async getMarker(operationId) {
    assertOperationId(operationId);
    try { return JSON.parse(await readFile(this.markerPath(operationId), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw new OutboxError('Outbox persistence failed'); }
  }
  async writeMarker(envelope) { const item = this.toNewItem(envelope); return this.withLock(item.operation_id, async () => this.persist(() => this.writeMarkerUnlocked(item, { status: 'ok' }))); }

  async flush({ maxItems = 3, budgetMs = 1_500 } = {}) {
    // Hook callers intentionally drain at most three FIFO items inside one shared latency budget.
    // A higher-throughput background drain needs a separate rate-limit and ordering design.
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3 || !Number.isFinite(budgetMs) || budgetMs < 0) throw new OutboxError('Invalid flush options');
    const result = { processed: 0, acknowledged: 0, deferred: 0, failed: 0 };
    const deadline = this.monotonicNow() + budgetMs;
    const items = await this.listItems(deadline);
    const blockedSessions = new Set();
    for (const item of items) {
      if (result.processed >= maxItems || this.remaining(deadline) <= 0) { result.deferred += 1; continue; }
      if (blockedSessions.has(item.session_id)) { result.deferred += 1; continue; }
      if (item.manual_review === true || (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime())) {
        blockedSessions.add(item.session_id);
        result.deferred += 1;
        continue;
      }
      result.processed += 1;
      try {
        const outcome = await this.withDeliveryLaneUntil(
          item.session_id,
          deadline,
          () => this.processOperation(idFor(item), deadline),
        );
        if (outcome === 'acknowledged') result.acknowledged += 1;
        else if (outcome === 'failed') result.failed += 1;
        else if (outcome === 'deferred') result.deferred += 1;
        if (outcome !== 'acknowledged') blockedSessions.add(item.session_id);
      } catch (error) {
        if (error instanceof OutboxError && error.corrupt) { result.failed += 1; blockedSessions.add(item.session_id); continue; }
        throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed');
      }
    }
    return result;
  }

  toNewItem(envelope) {
    if (!isObject(envelope)) throw new OutboxError('Invalid outbox item');
    const { capture_id: captureId, type, session_id: sessionId, turn_id: turnId, payload } = envelope;
    assertCaptureId(captureId);
    const item = {
      version: 2, operation_id: captureId, operation_type: type, session_id: sessionId, turn_id: turnId,
      archive_generation: null, last_successful_capture_id: null,
      created_at: this.now().toISOString(), attempt_count: 0, next_retry_at: null, manual_review: false, payload,
    };
    if (!validOperationItem(item)) throw new OutboxError('Invalid outbox item');
    return item;
  }

  toNewOperation(operation) {
    if (!isObject(operation)) throw new OutboxError('Invalid outbox operation');
    const item = {
      version: 2,
      operation_id: operation.operation_id,
      operation_type: operation.operation_type,
      session_id: operation.session_id,
      turn_id: null,
      archive_generation: operation.archive_generation,
      last_successful_capture_id: operation.last_successful_capture_id,
      created_at: this.now().toISOString(),
      attempt_count: 0,
      next_retry_at: null,
      manual_review: false,
      payload: operation.payload,
    };
    if (!validOperationItem(item)) throw new OutboxError('Invalid outbox operation');
    return item;
  }

  async process(captureId, deadline) {
    if (this.remaining(deadline) <= 0) return 'deferred';
    const outcome = await this.withLockUntil(captureId, deadline, async () => this.processLocked(captureId, deadline));
    if (!outcome || typeof outcome === 'string') return outcome;
    await this.persist(() => this.onAcknowledged(outcome.item, outcome.result));
    if (this.remaining(deadline) > 0) {
      await this.withLockUntil(captureId, deadline, async () => {
        if (await this.hasMarkerUnlocked(captureId)) await this.persist(() => this.deleteItem(captureId));
      });
    }
    return 'acknowledged';
  }

  async processLocked(captureId, deadline) {
    if (this.remaining(deadline) <= 0) return 'deferred';
    if (await this.hasMarkerUnlocked(captureId)) {
      const item = await this.readItemUnlocked(captureId, true);
      if (item !== null && this.remaining(deadline) > 0) {
        const marker = await this.getMarker(captureId);
        return { status: 'acknowledging', item, result: marker?.result };
      }
      return 'acknowledged';
    }
    if (this.remaining(deadline) <= 0) return 'deferred';
    const item = await this.readItemUnlocked(captureId, true);
    if (item === null) return 'deferred';
    if (item.next_retry_at !== null && Date.parse(item.next_retry_at) > this.now().getTime()) return 'deferred';
    if (!(await this.persist(() => this.shouldProcess(item)))) {
      await this.persist(() => this.deleteItem(captureId));
      return 'acknowledged';
    }
    const gatewayOutcome = await this.callGateway(item, deadline);
    if (gatewayOutcome.status === 'deadline') return 'deferred';
    if (gatewayOutcome.status === 'failed') {
      if (this.remaining(deadline) <= 0) return 'deferred';
      if (item.version === 2 && gatewayOutcome.retryable === false) {
        await this.persist(() => this.writeItem({ ...item, manual_review: true, next_retry_at: null }));
        return 'failed';
      }
      const delay = BACKOFF_MS[Math.min(item.attempt_count, BACKOFF_MS.length - 1)];
      await this.persist(() => this.writeItem({ ...item, attempt_count: item.attempt_count + 1, next_retry_at: new Date(this.now().getTime() + delay).toISOString() }));
      return 'failed';
    }
    if (this.remaining(deadline) <= 0) return 'deferred';
    await this.persist(() => this.writeMarkerUnlocked(item, gatewayOutcome.response));
    return { status: 'acknowledging', item, result: gatewayOutcome.response };
  }

  async callGateway(item, deadline) {
    const timeoutMs = this.remaining(deadline);
    if (timeoutMs <= 0) return { status: 'deadline' };
    const method = item.version === 2 && item.operation_type === 'force_archive' ? 'forceArchive' : 'skillConversationAdd';
    if (!this.gatewayClient || typeof this.gatewayClient[method] !== 'function') return { status: 'failed', retryable: true };
    const controller = new AbortController();
    let timer;
    const call = Promise.resolve().then(() => this.gatewayClient[method](item.payload, { timeoutMs, signal: controller.signal }));
    const settled = call.then((response) => ({ status: 'ok', response }), (error) => ({ status: 'failed', retryable: error?.retryable !== false }));
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'deadline' }); }, timeoutMs); });
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
      const captureId = entry.name.slice(0, -5); if (!OPERATION_ID.test(captureId)) continue;
      try { const item = await this.readItemUnlocked(captureId); if (item !== null) items.push(item); }
      catch (error) { if (!(error instanceof OutboxError) || !error.corrupt) throw error; }
    }
    return items.sort((left, right) => left.created_at.localeCompare(right.created_at) || idFor(left).localeCompare(idFor(right)));
  }

  async listDrainCandidates(deadline) { return this.listItems(deadline); }
  async processOperation(operationId, deadline) { assertOperationId(operationId); return this.process(operationId, deadline); }

  async withDeliveryLaneUntil(sessionId, deadline, operation) {
    if (typeof operation !== 'function') throw new OutboxError('Invalid delivery operation');
    const remaining = Math.floor(this.remaining(deadline));
    if (remaining <= 0) return 'deferred';
    try {
      return await withSessionLock(this.deliveryLockPath(sessionId), operation, {
        ...this.lockOptions,
        timeoutMs: remaining,
        retryMs: Math.max(1, Math.min(20, remaining)),
      });
    } catch (error) {
      if (error instanceof SessionLockTimeoutError) return 'deferred';
      throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed');
    }
  }

  async readItemUnlocked(captureId, missingOk = false) {
    let source;
    try { source = await readFile(this.outboxPath(captureId), 'utf8'); }
    catch (error) { if (missingOk && error?.code === 'ENOENT') return null; throw new OutboxError('Outbox persistence failed'); }
    let item; try { item = JSON.parse(source); } catch { throw corrupt(); }
    if (!validAnyItem(item) || idFor(item) !== captureId) throw corrupt(); return item;
  }

  async hasMarkerUnlocked(captureId) {
    let source;
    try { source = await readFile(this.markerPath(captureId), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw new OutboxError('Outbox persistence failed'); }
    let marker; try { marker = JSON.parse(source); } catch { throw corrupt(); }
    if (!isValidOutboxMarker(marker, captureId)) throw corrupt();
    return true;
  }

  async writeItem(item) { await writeJsonAtomically(this.outboxPath(idFor(item)), item); }
  async writeMarkerUnlocked(item, result) {
    const marker = item.version === 2
      ? { version: 2, operation_id: item.operation_id, completed_at: this.now().toISOString(), operation_type: item.operation_type, session_id: item.session_id, ...(item.operation_type === 'skill_conversation' ? { turn_id: item.turn_id } : {}), result }
      : { version: 2, operation_id: item.capture_id, completed_at: this.now().toISOString(), operation_type: item.type, session_id: item.session_id, turn_id: item.turn_id, result };
    await writeJsonAtomically(this.markerPath(idFor(item)), marker);
  }
  async deleteItem(captureId) { await rm(this.outboxPath(captureId), { force: true }); }
  async persist(operation) { try { return await operation(); } catch (error) { throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed'); } }
  async withLock(captureId, operation, options = {}) { try { return await withSessionLock(this.lockPath(captureId), operation, { ...this.lockOptions, ...options }); } catch (error) { throw error instanceof OutboxError ? error : new OutboxError('Outbox persistence failed'); } }
  async withLockUntil(captureId, deadline, operation) {
    const remaining = Math.floor(this.remaining(deadline)); if (remaining <= 0) return 'deferred';
    return this.withLock(captureId, operation, { timeoutMs: remaining, retryMs: Math.max(1, Math.min(20, remaining)) });
  }

  async hasPendingCaptureForSession(sessionId) {
    if (!nonEmpty(sessionId)) throw new OutboxError('Invalid session id');
    let entries;
    try { entries = await readdir(join(this.stateDir, 'outbox'), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw new OutboxError('Outbox persistence failed'); }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('cap_sha256_') || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      try {
        const item = await this.readItemUnlocked(id);
        if (item?.session_id === sessionId) return true;
      } catch (error) { if (!(error instanceof OutboxError && error.corrupt)) throw error; }
    }
    return false;
  }

  async cancelForceOperations(sessionId, archiveGeneration) {
    if (!nonEmpty(sessionId) || !Number.isInteger(archiveGeneration) || archiveGeneration < 0) throw new OutboxError('Invalid archive generation');
    let entries;
    try { entries = await readdir(join(this.stateDir, 'outbox'), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw new OutboxError('Outbox persistence failed'); }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('op_sha256_') || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      const deleted = await this.withLock(id, async () => {
        let item;
        try { item = await this.readItemUnlocked(id, true); } catch (error) { if (error instanceof OutboxError && error.corrupt) return false; throw error; }
        if (item?.operation_type !== 'force_archive' || item.session_id !== sessionId || item.archive_generation !== archiveGeneration) return false;
        await this.deleteItem(id);
        return true;
      });
      if (deleted) removed += 1;
    }
    return removed;
  }
}
