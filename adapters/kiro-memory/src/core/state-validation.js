import { sha256 } from './hash.js';
import { isValidOutboxItem, isValidOutboxMarker } from './outbox.js';
import { isValidTurn } from './turn-store.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isoOrNull = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const sessionMatch = (hash, sessionId) => typeof sessionId === 'string' && sha256(sessionId) === hash;

export const validateArchiveMetadata = (value, sessionHash) => exact(value, ['version', 'session_hash', 'last_successful_append_at', 'last_successful_capture_id', 'last_archive_at', 'archive_generation'])
  && value.version === 1 && value.session_hash === `sha256:${sessionHash}`
  && isoOrNull(value.last_successful_append_at) && isoOrNull(value.last_archive_at)
  && (value.last_successful_capture_id === null || /^cap_sha256_[a-f0-9]{64}$/u.test(value.last_successful_capture_id))
  && Number.isInteger(value.archive_generation) && value.archive_generation >= 0;

export function validateKnownStateObject(path, value) {
  if (path === 'state.json') return exact(value, ['version', 'adapter', 'created_at'])
    && value.version === 2 && value.adapter === 'kiro-memory' && isoOrNull(value.created_at) && value.created_at !== null;

  const archive = /^sessions\/([a-f0-9]{64})\/archive\.json$/u.exec(path);
  if (archive) return validateArchiveMetadata(value, archive[1]);

  const active = /^sessions\/([a-f0-9]{64})\/active\.json$/u.exec(path);
  if (active) return exact(value, ['version', 'session_id', 'active_turn_id']) && value.version === 1
    && sessionMatch(active[1], value.session_id) && typeof value.active_turn_id === 'string' && value.active_turn_id.length > 0;

  const turn = /^sessions\/([a-f0-9]{64})\/turns\/(.+)\.json$/u.exec(path);
  if (turn) {
    let turnId;
    try { turnId = decodeURIComponent(turn[2]); } catch { return false; }
    return sessionMatch(turn[1], value?.session_id) && isValidTurn(value, value.session_id, turnId);
  }

  const outbox = /^outbox\/([^/]+)\.json$/u.exec(path);
  if (outbox) return isValidOutboxItem(value)
    && (value.operation_id ?? value.capture_id) === outbox[1];
  const marker = /^captured\/([^/]+)\.json$/u.exec(path);
  if (marker) return isValidOutboxMarker(value, marker[1]);
  return null;
}
