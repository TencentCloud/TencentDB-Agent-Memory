export const MAX_L1_CONCURRENCY = 32;

export function normalizeL1Concurrency(value, fallback = 1) {
  return positiveInteger(value, fallback, MAX_L1_CONCURRENCY);
}

export function positiveInteger(value, fallback, max = MAX_L1_CONCURRENCY) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}
