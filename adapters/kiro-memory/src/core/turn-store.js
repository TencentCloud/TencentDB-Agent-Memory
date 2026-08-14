import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomically } from './atomic-file.js';
import { sha256 } from './hash.js';

export class TurnStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TurnStoreError';
  }
}

const safeTurnFileName = (turnId) => `${encodeURIComponent(turnId)}.json`;

const isValidTurn = (turn, sessionId, turnId) => (
  turn !== null
  && typeof turn === 'object'
  && turn.version === 1
  && turn.turn_id === turnId
  && turn.session_id === sessionId
  && (!Object.hasOwn(turn, 'cwd') || typeof turn.cwd === 'string')
  && typeof turn.prompt === 'string'
  && typeof turn.created_at === 'string'
  && (turn.completed_at === null || typeof turn.completed_at === 'string')
  && (turn.lifecycle_status === 'pending' || turn.lifecycle_status === 'completed')
  && typeof turn.capture_status === 'string'
  && turn.assistant_observation !== null
  && typeof turn.assistant_observation === 'object'
  && typeof turn.assistant_observation.available === 'boolean'
  && Object.hasOwn(turn.assistant_observation, 'content')
  && Array.isArray(turn.tool_events)
  && turn.prompt_hash === `sha256:${sha256(turn.prompt)}`
  && (turn.capture_id === null || typeof turn.capture_id === 'string')
);

export class TurnStore {
  constructor({ stateDir, idFactory = randomUUID, now = () => new Date() }) {
    this.stateDir = stateDir;
    this.idFactory = idFactory;
    this.now = now;
  }

  sessionDirectory(sessionId) {
    return join(this.stateDir, 'sessions', sha256(sessionId));
  }

  activePath(sessionId) {
    return join(this.sessionDirectory(sessionId), 'active.json');
  }

  turnPath(sessionId, turnId) {
    return join(this.sessionDirectory(sessionId), 'turns', safeTurnFileName(turnId));
  }

  async createTurn({ sessionId, cwd, prompt }) {
    this.assertSessionId(sessionId, 'createTurn');
    if (typeof prompt !== 'string') throw new TurnStoreError('createTurn failed: prompt');

    const turnId = this.idFactory();
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TurnStoreError('createTurn failed: turn_id');
    }
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
  }

  async getActiveTurn(sessionId) {
    this.assertSessionId(sessionId, 'getActiveTurn');
    const active = await this.readActivePointer(sessionId);
    if (active === null) return null;
    return this.readTurn(sessionId, active.active_turn_id, 'getActiveTurn');
  }

  async appendToolEvent(sessionId, toolEvent) {
    this.assertSessionId(sessionId, 'appendToolEvent');
    const active = await this.getActiveTurn(sessionId);
    if (active === null) return null;
    const eventCopy = structuredClone(toolEvent);
    active.tool_events.push(eventCopy);
    await this.writeTurn(sessionId, active, 'appendToolEvent');
    return active;
  }

  async completeTurn(sessionId) {
    this.assertSessionId(sessionId, 'completeTurn');
    const active = await this.getActiveTurn(sessionId);
    if (active === null || active.lifecycle_status === 'completed') return active;
    active.lifecycle_status = 'completed';
    active.completed_at = this.now().toISOString();
    await this.writeTurn(sessionId, active, 'completeTurn');
    return active;
  }

  async clearActiveTurn(sessionId, expectedTurnId) {
    this.assertSessionId(sessionId, 'clearActiveTurn');
    const active = await this.readActivePointer(sessionId);
    if (active === null || active.active_turn_id !== expectedTurnId) return false;
    try {
      await rm(this.activePath(sessionId));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new TurnStoreError('clearActiveTurn failed: active.json');
    }
  }

  async markCaptureStatus(sessionId, turnId, captureStatus, captureId = null) {
    this.assertSessionId(sessionId, 'markCaptureStatus');
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TurnStoreError('markCaptureStatus failed: turn_id');
    }
    const turn = await this.readTurn(sessionId, turnId, 'markCaptureStatus');
    turn.capture_status = captureStatus;
    turn.capture_id = captureId;
    await this.writeTurn(sessionId, turn, 'markCaptureStatus');
    return turn;
  }

  assertSessionId(sessionId, operation) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TurnStoreError(`${operation} failed: session_id`);
    }
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
