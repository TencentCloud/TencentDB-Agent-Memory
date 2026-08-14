import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { withSessionLock, writeJsonAtomically } from './atomic-file.js';
import { sha256 } from './hash.js';

export class TurnStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TurnStoreError';
  }
}

const safeTurnFileName = (turnId) => `${encodeURIComponent(turnId)}.json`;

const captureStatuses = new Set([
  'not_started',
  'full_capture_pending',
  'full_captured',
  'partial_capture_pending',
  'partial_captured',
  'retry_pending',
  'skipped_no_observable_data',
]);

const isIsoTimestamp = (value) => (
  typeof value === 'string'
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value
);

const isValidTurn = (turn, sessionId, turnId) => (
  turn !== null
  && typeof turn === 'object'
  && turn.version === 1
  && turn.turn_id === turnId
  && turn.session_id === sessionId
  && (!Object.hasOwn(turn, 'cwd') || typeof turn.cwd === 'string')
  && typeof turn.prompt === 'string'
  && isIsoTimestamp(turn.created_at)
  && (
    (turn.lifecycle_status === 'pending' && turn.completed_at === null)
    || (turn.lifecycle_status === 'completed' && isIsoTimestamp(turn.completed_at))
  )
  && captureStatuses.has(turn.capture_status)
  && turn.assistant_observation?.available === false
  && turn.assistant_observation?.content === null
  && Array.isArray(turn.tool_events)
  && turn.prompt_hash === `sha256:${sha256(turn.prompt)}`
  && (turn.capture_id === null || typeof turn.capture_id === 'string')
);

export class TurnStore {
  constructor({
    stateDir,
    idFactory = randomUUID,
    now = () => new Date(),
    lockTimeoutMs,
    lockRetryMs,
  }) {
    this.stateDir = stateDir;
    this.idFactory = idFactory;
    this.now = now;
    this.lockOptions = {
      ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }),
      ...(lockRetryMs === undefined ? {} : { retryMs: lockRetryMs }),
    };
  }

  sessionDirectory(sessionId) {
    return join(this.stateDir, 'sessions', sha256(sessionId));
  }

  activePath(sessionId) {
    return join(this.sessionDirectory(sessionId), 'active.json');
  }

  lockPath(sessionId) {
    return join(this.sessionDirectory(sessionId), '.turn-state.lock');
  }

  turnPath(sessionId, turnId) {
    return join(this.sessionDirectory(sessionId), 'turns', safeTurnFileName(turnId));
  }

  async createTurn({ sessionId, cwd, prompt }) {
    this.assertSessionId(sessionId, 'createTurn');
    if (typeof prompt !== 'string') throw new TurnStoreError('createTurn failed: prompt');
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new TurnStoreError('createTurn failed: cwd');
    }
    return this.withLock(sessionId, async () => {
      const turnId = this.idFactory();
      if (typeof turnId !== 'string' || turnId.length === 0) {
        throw new TurnStoreError('createTurn failed: turn_id');
      }
      await this.assertTurnDoesNotExist(sessionId, turnId);
      const timestamp = this.now().toISOString();
      const turn = {
        version: 1,
        turn_id: turnId,
        session_id: sessionId,
        ...(cwd === undefined ? {} : { cwd }),
        prompt,
        created_at: timestamp,
        completed_at: null,
        lifecycle_status: 'pending',
        capture_status: 'not_started',
        assistant_observation: { available: false, content: null },
        tool_events: [],
        prompt_hash: `sha256:${sha256(prompt)}`,
        capture_id: null,
      };

      try {
        await writeJsonAtomically(this.turnPath(sessionId, turnId), turn);
      } catch {
        throw new TurnStoreError('createTurn failed: turn_id');
      }
      try {
        await writeJsonAtomically(this.activePath(sessionId), {
          version: 1,
          session_id: sessionId,
          active_turn_id: turnId,
        });
      } catch {
        throw new TurnStoreError('createTurn failed: active.json');
      }
      return turn;
    });
  }

  async getActiveTurn(sessionId) {
    this.assertSessionId(sessionId, 'getActiveTurn');
    const active = await this.readActivePointer(sessionId);
    if (active === null) return null;
    return this.readTurn(sessionId, active.active_turn_id, 'getActiveTurn');
  }

  async appendToolEvent(sessionId, toolEvent) {
    this.assertSessionId(sessionId, 'appendToolEvent');
    return this.withLock(sessionId, async () => {
      const active = await this.getActiveTurn(sessionId);
      if (active === null) return null;
      const eventCopy = structuredClone(toolEvent);
      active.tool_events.push(eventCopy);
      await this.writeTurn(sessionId, active, 'appendToolEvent');
      return active;
    });
  }

  async completeTurn(sessionId) {
    this.assertSessionId(sessionId, 'completeTurn');
    return this.withLock(sessionId, async () => {
      const active = await this.getActiveTurn(sessionId);
      if (active === null || active.lifecycle_status === 'completed') return active;
      active.lifecycle_status = 'completed';
      active.completed_at = this.now().toISOString();
      await this.writeTurn(sessionId, active, 'completeTurn');
      return active;
    });
  }

  async clearActiveTurn(sessionId, expectedTurnId) {
    this.assertSessionId(sessionId, 'clearActiveTurn');
    return this.withLock(sessionId, async () => {
      const active = await this.readActivePointer(sessionId);
      if (active === null || active.active_turn_id !== expectedTurnId) return false;
      try {
        await rm(this.activePath(sessionId));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw new TurnStoreError('clearActiveTurn failed: active.json');
      }
    });
  }

  async markCaptureStatus(sessionId, turnId, captureStatus, captureId = null) {
    this.assertSessionId(sessionId, 'markCaptureStatus');
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TurnStoreError('markCaptureStatus failed: turn_id');
    }
    if (!captureStatuses.has(captureStatus)) {
      throw new TurnStoreError('markCaptureStatus failed: capture_status');
    }
    if (captureId !== null && typeof captureId !== 'string') {
      throw new TurnStoreError('markCaptureStatus failed: capture_id');
    }
    return this.withLock(sessionId, async () => {
      const turn = await this.readTurn(sessionId, turnId, 'markCaptureStatus');
      turn.capture_status = captureStatus;
      turn.capture_id = captureId;
      await this.writeTurn(sessionId, turn, 'markCaptureStatus');
      return turn;
    });
  }

  assertSessionId(sessionId, operation) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TurnStoreError(`${operation} failed: session_id`);
    }
  }

  async withLock(sessionId, operation) {
    try {
      return await withSessionLock(this.lockPath(sessionId), operation, this.lockOptions);
    } catch (error) {
      if (error instanceof TurnStoreError) throw error;
      throw new TurnStoreError('turn state mutation failed: session lock');
    }
  }

  async assertTurnDoesNotExist(sessionId, turnId) {
    try {
      await readFile(this.turnPath(sessionId, turnId));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new TurnStoreError('createTurn failed: turn_id');
    }
    throw new TurnStoreError('createTurn failed: turn_id');
  }

  async readActivePointer(sessionId) {
    const active = await this.readJson(this.activePath(sessionId), 'active.json', true);
    if (active === null) return null;
    if (
      active === null
      || typeof active !== 'object'
      || active.version !== 1
      || active.session_id !== sessionId
      || typeof active.active_turn_id !== 'string'
      || active.active_turn_id.length === 0
    ) {
      throw new TurnStoreError('getActiveTurn failed: active.json');
    }
    return active;
  }

  async readTurn(sessionId, turnId, operation) {
    const turn = await this.readJson(this.turnPath(sessionId, turnId), 'turn_id');
    if (!isValidTurn(turn, sessionId, turnId)) {
      throw new TurnStoreError(`${operation} failed: turn_id`);
    }
    return turn;
  }

  async writeTurn(sessionId, turn, operation) {
    try {
      await writeJsonAtomically(this.turnPath(sessionId, turn.turn_id), turn);
    } catch {
      throw new TurnStoreError(`${operation} failed: turn_id`);
    }
  }

  async readJson(path, fieldName, allowMissing = false) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      throw new TurnStoreError(`read failed: ${fieldName}`);
    }
  }
}
