import {Worker} from 'node:worker_threads';
import {compactPublicMapping} from './v9-isolated-runtime.mjs';

export async function isolatedV10Selection(input, {timeoutMs = 3000, signal,
  workerFactory = opts => new Worker(new URL('./v10-worker-bootstrap.mjs', import.meta.url), opts)} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || JSON.stringify(input).length > 2_000_000) throw Error('v10_worker_bounds');
  signal?.throwIfAborted();
  const worker = workerFactory({workerData: input, resourceLimits: {maxOldGenerationSizeMb: 192}});
  let timer, aborted;
  try {return await new Promise((resolve, reject) => {
    aborted = () => reject(Error('v10_worker_aborted'));
    signal?.addEventListener('abort', aborted, {once: true});
    if (signal?.aborted) return aborted();
    timer = setTimeout(() => reject(Error('v10_worker_timeout')), timeoutMs);
    worker.once('message', r => r?.ok ? resolve(r.result) : reject(Error('v10_worker_rejected:' + (r?.reason ?? 'unknown'))));
    worker.once('error', () => reject(Error('v10_worker_error')));
    worker.once('exit', () => reject(Error('v10_worker_exit')));
  });} finally {clearTimeout(timer); signal?.removeEventListener('abort', aborted); await worker.terminate();}
}

// Pure retrieval adapter boundary. Does not load benchmark records or reference labels.
export async function adaptiveRetrieveV10({enabled = false, client, scope, query, loadModel, loadMapping,
  runtime, mode = 'intervention_residual', timeoutMs = 8000, workerTimeoutMs = 3000, workerFactory,
  scoreOptions = {}}) {
  const baseline = () => client.search(scope, query, 5);
  if (!enabled) return {...await baseline(), mode: 'disabled', fallback: false};
  const start = performance.now(), abort = new AbortController(), stages = {}; let timer, workerTask, scoreStarted = false;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw Error('v10_request_deadline');
    const work = async () => {
      let t = performance.now();
      const [model, metadata] = await Promise.all([mode === 'qwen_fixed' ? null : loadModel(), loadMapping()]);
      abort.signal.throwIfAborted(); stages.metadata_ms = performance.now() - t;
      t = performance.now();
      const native = await client.search(scope, query, 5, {signal: abort.signal});
      const pool = await client.search(scope, query, 32, {signal: abort.signal});
      abort.signal.throwIfAborted(); stages.retrieval_ms = performance.now() - t;
      const mapping = compactPublicMapping(metadata.mapping, [...pool.items, ...native.items]);
      t = performance.now(); scoreStarted = true;
      const score = await runtime.score(query, pool.items, mapping, {...scoreOptions, signal: abort.signal});
      abort.signal.throwIfAborted(); stages.rerank_ms = performance.now() - t;
      t = performance.now();
      workerTask = isolatedV10Selection({query, items: pool.items, native_items: native.items, scores: score.scores,
        mapping, context_prefix: metadata.context_prefix ?? '', mode, model}, {timeoutMs: workerTimeoutMs, signal: abort.signal, workerFactory});
      const result = await workerTask; stages.worker_ms = performance.now() - t;
      return {...result, mode, fallback: false, stages, total_ms: performance.now() - start,
        native_request_id: native.request_id, pool_request_id: pool.request_id, scorer_input_tokens: score.input_tokens};
    };
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => {abort.abort(Error('v10_total_timeout')); reject(Error('v10_total_timeout'));}, timeoutMs);
    })]);
  } catch (error) {
    abort.abort(error);
    // The owned scorer and any selector work are terminated before returning fresh native data.
    if (scoreStarted) await runtime.stop();
    if (workerTask) await workerTask.catch(() => {});
    const result = await baseline();
    return {...result, mode: 'fallback', attempted_mode: mode, fallback: true, fallback_reason: error.message,
      stages, total_ms: performance.now() - start};
  } finally {clearTimeout(timer); abort.abort();}
}
