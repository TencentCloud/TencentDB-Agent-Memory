/**
 * Bounds the Wiki detail progress poll so a backend job that has stopped
 * reporting progress cannot leave the UI in an endless "checking" loop.
 */

export const MAX_INGEST_POLL_ATTEMPTS = 300;
export const MAX_INGEST_POLL_FAILURES = 3;

export type IngestPollPauseReason = 'timeout' | 'network';

export interface IngestPollHealth {
  attempts: number;
  consecutiveFailures: number;
}

export const INITIAL_INGEST_POLL_HEALTH: IngestPollHealth = {
  attempts: 0,
  consecutiveFailures: 0,
};

export function advanceIngestPollHealth(
  health: IngestPollHealth,
  succeeded: boolean,
): IngestPollHealth & { pauseReason: IngestPollPauseReason | null } {
  const attempts = health.attempts + 1;
  const consecutiveFailures = succeeded ? 0 : health.consecutiveFailures + 1;
  const pauseReason =
    attempts >= MAX_INGEST_POLL_ATTEMPTS
      ? 'timeout'
      : consecutiveFailures >= MAX_INGEST_POLL_FAILURES
        ? 'network'
        : null;

  return { attempts, consecutiveFailures, pauseReason };
}
