/**
 * Coordinate asynchronous response-side counters with usage-log emission.
 *
 * The client response remains fire-and-forget. Only the usage/ClickHouse row
 * waits for counters that depend on response-side CFQ fallback generation.
 */

const pending = new WeakMap<Record<string, unknown>, Promise<void>>();

export function registerResponseStatsReady(
  stats: Record<string, unknown>,
  ready: Promise<void>,
): void {
  pending.set(stats, ready);
}

/** Return and consume pending response-side work for this stats object. */
export function takeResponseStatsReady(
  stats: Record<string, unknown> | undefined,
): Promise<void> | undefined {
  if (!stats) return undefined;
  const ready = pending.get(stats);
  if (ready) pending.delete(stats);
  return ready;
}
