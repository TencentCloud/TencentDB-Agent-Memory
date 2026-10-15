import {Worker} from 'node:worker_threads';

export async function isolatedV9Selection(input, {timeoutMs = 3000, workerFactory = opts =>
  new Worker(new URL('./v9-selection-worker-bootstrap.mjs', import.meta.url), opts)} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw Error('worker_deadline');
  if (JSON.stringify(input).length > 2_000_000) throw Error('worker_capacity');
  const worker = workerFactory({workerData: input, resourceLimits: {maxOldGenerationSizeMb: 192}});
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('v9_worker_timeout')), timeoutMs);
      worker.once('message', r => r?.ok ? resolve(r.result) : reject(Error('v9_worker_rejected:' + (r?.reason ?? 'unknown'))));
      worker.once('error', () => reject(Error('v9_worker_error')));
      worker.once('exit', () => reject(Error('v9_worker_exit')));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

async function bounded(work, ms, label, signal) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => work(signal)),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error(label)), ms);})]);
  } finally {clearTimeout(timer);}
}

// The prepare adapter is responsible for honoring AbortSignal on I/O. Only the
// selector CPU work is forcibly isolated. Baseline errors intentionally propagate.
export async function guardedIsolatedV9({enabled = false, baseline, load, prepare,
  prepareTimeoutMs = 5000, workerTimeoutMs = 3000, workerFactory}) {
  if (!enabled) return {...await baseline(), mode: 'disabled', fallback: false};
  const start = performance.now(), abort = new AbortController();
  try {
    if (!Number.isInteger(prepareTimeoutMs) || prepareTimeoutMs < 1 || prepareTimeoutMs > 10000)
      throw Error('prepare_deadline');
    const config = await bounded(load, 50, 'policy_timeout', abort.signal);
    const input = await bounded(signal => prepare(config, signal), prepareTimeoutMs, 'prepare_timeout', abort.signal);
    const result = await isolatedV9Selection(input, {timeoutMs: workerTimeoutMs, workerFactory});
    return {...result, mode: 'v9_isolated', fallback: false, total_ms: performance.now() - start};
  } catch (error) {
    abort.abort(error);
    const result = await baseline();
    return {...result, mode: 'fallback', fallback: true, fallback_reason: error.message,
      total_ms: performance.now() - start};
  } finally {abort.abort();}
}

export function compactPublicMapping(mapping, items) {
  const accepted = {}, turns = {};
  for (const x of items) {
    const entry = mapping.accepted[x.id];
    if (!entry || !mapping.turns[entry.turn_id]) throw Error('mapping_missing');
    accepted[x.id] = entry;
    turns[entry.turn_id] = mapping.turns[entry.turn_id];
  }
  return {accepted, turns};
}
