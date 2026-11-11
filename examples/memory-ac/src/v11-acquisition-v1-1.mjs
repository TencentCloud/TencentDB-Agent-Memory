import {hash} from './adapters.mjs';
import {acquire as originalAcquire} from './v11-acquisition.mjs';
export {removalOpportunities} from './v11-acquisition.mjs';
export function acquire(opportunities, arm, limit = 32) {
  // Reuse all bounds. Query order must be independent of its opportunity count.
  const checked = originalAcquire(opportunities, arm, limit);
  if (arm !== 'uniform') return checked;
  const queries = Object.entries(Object.groupBy(opportunities, x => x.probe_id)).sort(([a], [b]) =>
    hash('v11-uniform-query:' + a).localeCompare(hash('v11-uniform-query:' + b)));
  return queries.slice(0, limit).map(([, xs]) => [...xs].sort((a, b) =>
    hash('v11-uniform-opportunity:' + a.key).localeCompare(hash('v11-uniform-opportunity:' + b.key)))[0]);
}
