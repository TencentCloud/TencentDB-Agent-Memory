import {Worker} from 'node:worker_threads';
import {adaptiveRetrieveV10} from './v10-runtime.mjs';
// Reuse the tested deadline/abort/fresh-native fallback boundary unchanged.
export function adaptiveRetrieveV11(options) {
  return adaptiveRetrieveV10({...options, mode: options.mode ?? 'slate_active', workerFactory: options.workerFactory
    ?? (opts => new Worker(new URL('./v11-worker-bootstrap.mjs', import.meta.url), opts))});
}
