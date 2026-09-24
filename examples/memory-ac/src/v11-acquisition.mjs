import {hash} from './adapters.mjs';

// Evaluator-only. This module uses annotated sources and training outcomes;
// importing it from the runtime selector is forbidden by contract tests.
export function removalOpportunities({probeId, items, mapping, goldIds, cost}) {
  if (!Array.isArray(items) || items.length > 5 || new Set(items.map(x => x.id)).size !== items.length || goldIds.length > 64) throw Error('acquisition_bounds');
  const present = new Set(items.map(x => x.id)), gold = new Set(goldIds);
  for (const x of items) if (hash(x.content) !== mapping.accepted[x.id]?.content_hash) throw Error('acquisition_provenance');
  if (!gold.size || [...gold].some(t => !mapping.turns[t]?.length || !mapping.turns[t].every(id => present.has(id)))) return [];
  const controls = items.filter(x => !gold.has(mapping.accepted[x.id].turn_id)), baseTokens = cost(items), output = [];
  for (const target of [...gold].sort()) {
    const drop = new Set(mapping.turns[target]), support = items.filter(x => !drop.has(x.id));
    const removedTokens = baseTokens - cost(support), tolerance = Math.max(8, .05 * Math.max(1, removedTokens));
    for (let mask = 1; mask < 2 ** controls.length; mask++) {
      const removed = controls.filter((_, i) => (mask >> i) & 1);
      if (removed.length !== drop.size) continue;
      const ids = new Set(removed.map(x => x.id)), control = items.filter(x => !ids.has(x.id));
      const gap = Math.abs(cost(support) - cost(control));
      if (gap <= tolerance) output.push({target, support_items: support, control_items: control,
        support_removed_ids: [...drop], control_removed_ids: [...ids], removed_tokens: removedTokens, token_gap: gap, tolerance,
        key: hash(JSON.stringify([probeId, items.map(x => x.id), [...drop], [...ids]]))});
    }
  }
  if (output.length > 150) throw Error('acquisition_capacity');
  return output;
}

export function acquire(opportunities, arm, limit = 32) {
  if (!['active', 'uniform'].includes(arm) || limit !== 32 || opportunities.length > 40000
    || opportunities.some(x => x.split !== 'train' || !Number.isFinite(x.novelty) || ![0, 1].includes(x.repair))) throw Error('acquisition_contract');
  const rank = (a, b) => arm === 'active'
    ? b.repair - a.repair || b.novelty - a.novelty || hash('v11-active:' + a.key).localeCompare(hash('v11-active:' + b.key))
    : hash('v11-uniform:' + a.key).localeCompare(hash('v11-uniform:' + b.key));
  // At most one opportunity per question in each arm; the same group may contain multiple questions.
  const best = Object.values(Object.groupBy(opportunities, x => x.probe_id)).map(xs => [...xs].sort(rank)[0]);
  return best.sort(rank).slice(0, limit);
}
