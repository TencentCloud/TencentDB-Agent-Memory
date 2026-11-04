import {parentPort, workerData as input} from 'node:worker_threads';
import {hash} from './adapters.mjs';
import {selectFixed, selectBeam} from './v9-selection.mjs';
import {exactTokenCounter} from './v9-token-cache.mjs';
import {getEncoding} from '../vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/js-tiktoken/dist/index.js';
import {formatConversationSearchResponse} from '../vendor/TencentDB-Agent-Memory/MemoryCore/src/core/tools/conversation-search.ts';

try {
  const allowed = new Set(['query', 'items', 'native_items', 'scores', 'mapping', 'context_prefix', 'family', 'alpha']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw Error('unexpected_input_field');
  if (typeof input.query !== 'string' || input.query.length > 20000 || !Array.isArray(input.items)
      || input.items.length > 64 || !Array.isArray(input.native_items) || input.native_items.length > 5)
    throw Error('input_bounds');
  const prefix = input.context_prefix ?? '';
  if (typeof prefix !== 'string' || prefix.length > 2048) throw Error('prefix_bounds');
  const ids = new Map([...input.items, ...input.native_items].map(x => [x.id, x]));
  for (const x of ids.values()) if (hash(x.content) !== input.mapping.accepted[x.id]?.content_hash)
    throw Error('content_binding');
  const encoding = getEncoding('cl100k_base'), counter = exactTokenCounter(encoding), cache = new Map();
  const render = items => prefix + formatConversationSearchResponse({strategy: 'fts', total: items.length,
    results: items.map(x => ({...x, session_key: input.mapping.accepted[x.id].session_id,
      recorded_at: input.mapping.accepted[x.id].source_date}))});
  const cost = items => {
    const key = items.map(x => x.id).join('|');
    if (!cache.has(key)) cache.set(key, counter.count(render(items)));
    return cache.get(key);
  };
  const nativeTokens = cost(input.native_items), budget = Math.floor(.8 * nativeTokens);
  const args = {...input, cost, budget};
  let selection;
  if (input.family === 'fixed') selection = selectFixed(args);
  else if (input.family === 'beam') selection = selectBeam(args);
  else throw Error('selection_family');
  const context = render(selection.items), exact = encoding.encode(context, 'all').length;
  if (exact !== selection.tokens || exact > budget) throw Error('final_budget_binding');
  parentPort.postMessage({ok: true, result: {...selection, context, context_sha256: hash(context),
    native_tokens: nativeTokens, counter_stats: counter.stats()}});
} catch (error) {
  parentPort.postMessage({ok: false, reason: error.message});
}
