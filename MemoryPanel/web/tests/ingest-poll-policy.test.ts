import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_INGEST_POLL_HEALTH,
  MAX_INGEST_POLL_ATTEMPTS,
  advanceIngestPollHealth,
} from '../src/pages/WikiPage/utils/ingest-poll-policy.ts';

test('healthy polls remain active until the hard attempt limit', () => {
  let health = INITIAL_INGEST_POLL_HEALTH;
  for (let i = 1; i < MAX_INGEST_POLL_ATTEMPTS; i++) {
    const next = advanceIngestPollHealth(health, true);
    assert.equal(next.pauseReason, null);
    health = next;
  }
  const final = advanceIngestPollHealth(health, true);
  assert.equal(final.attempts, MAX_INGEST_POLL_ATTEMPTS);
  assert.equal(final.pauseReason, 'timeout');
});

test('three consecutive failures stop polling', () => {
  let health = INITIAL_INGEST_POLL_HEALTH;
  health = advanceIngestPollHealth(health, false);
  health = advanceIngestPollHealth(health, false);
  assert.equal(health.pauseReason, null);
  const final = advanceIngestPollHealth(health, false);
  assert.equal(final.pauseReason, 'network');
});

test('a successful read resets the failure streak', () => {
  let health = INITIAL_INGEST_POLL_HEALTH;
  health = advanceIngestPollHealth(health, false);
  health = advanceIngestPollHealth(health, false);
  health = advanceIngestPollHealth(health, true);
  assert.equal(health.consecutiveFailures, 0);
  health = advanceIngestPollHealth(health, false);
  assert.equal(health.pauseReason, null);
});
