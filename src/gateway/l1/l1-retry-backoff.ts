const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

export function l1RetryAt(nowMs: number, priorFailures: number): number {
  const exponent = Math.min(Math.max(priorFailures, 0), 6);
  return nowMs + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exponent);
}
