import assert from 'node:assert/strict';
import {prepareV9} from './v9-context.mjs';
import {outcomeFeatures} from './v9-outcome-policy.mjs';

export const portfolioActions = Object.freeze([
  'ce_budget80', 'pure_ce_budget80', 'beam_budget80', 'qwen_fixed', 'qwen_beam',
]);

// This adapter constructs only public features. References never enter the learner's
// decision function. Each scoring backbone is retained in its own action head.
export function portfolioFeatures(record, views, miniScores, qwenScores) {
  const all = new Map([...record.items, ...record.native_items].map(x => [x.id, x]));
  const result = {};
  for (const action of portfolioActions) {
    const v = views.find(x => x.mode === action);
    assert(v, `missing_action:${action}`);
    const candidate = v.selected_ids.map(id => all.get(id));
    assert(candidate.every(Boolean));
    const scores = action.startsWith('qwen_') ? qwenScores : miniScores;
    const d = prepareV9({...record, scores});
    result[action] = outcomeFeatures({query: record.task.query, items: record.items,
      scores, mapping: record.mapping, native: record.native_items, candidate, cost: d.cost});
  }
  return result;
}
