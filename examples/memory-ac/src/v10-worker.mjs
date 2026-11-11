import {parentPort, workerData as input} from 'node:worker_threads';
import {hash} from './adapters.mjs';
import {candidateFeatures, residualScores} from './v10-residual.mjs';
import {selectFixed} from './v9-selection.mjs';
import {exactTokenCounter} from './v9-token-cache.mjs';
import {getEncoding} from '../vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/js-tiktoken/dist/index.js';
import {formatConversationSearchResponse} from '../vendor/TencentDB-Agent-Memory/MemoryCore/src/core/tools/conversation-search.ts';
try {
  const allowed = new Set(['query', 'items', 'native_items', 'scores', 'mapping', 'context_prefix', 'model', 'mode']);
  if (Object.keys(input).some(k => !allowed.has(k)) || !['qwen_fixed', 'qa_residual', 'intervention_residual', 'sham_residual'].includes(input.mode)) throw Error('worker_public_schema');
  if (typeof input.query !== 'string' || input.query.length > 20000 || input.items.length > 64 || input.native_items.length > 5) throw Error('worker_bounds');
  for (const x of [...input.items, ...input.native_items]) if (hash(x.content) !== input.mapping.accepted[x.id]?.content_hash) throw Error('worker_content_binding');
  const prefix = input.context_prefix ?? '';
  if (typeof prefix !== 'string' || prefix.length > 2048) throw Error('worker_prefix');
  const encoding = getEncoding('cl100k_base'), counter = exactTokenCounter(encoding), cache = new Map();
  const render = items => prefix + formatConversationSearchResponse({strategy: 'fts', total: items.length,
    results: items.map(x => ({...x, session_key: input.mapping.accepted[x.id].session_id, recorded_at: input.mapping.accepted[x.id].source_date}))});
  const cost = items => {const key = items.map(x => x.id).join('|'); if (!cache.has(key)) cache.set(key, counter.count(render(items))); return cache.get(key);};
  const featureStart = performance.now();
  const scores = input.mode === 'qwen_fixed' ? input.scores : residualScores(input.model, candidateFeatures({query: input.query,
    items: input.items, scores: input.scores, mapping: input.mapping, nativeIds: input.native_items.map(x => x.id)}));
  const feature_ms = performance.now() - featureStart, start = performance.now();
  const native_tokens = cost(input.native_items), budget = Math.floor(.8 * native_tokens);
  const selected = selectFixed({items: input.items, scores, cost, budget, alpha: 1});
  const context = render(selected.items), exact = encoding.encode(context, 'all').length;
  if (exact !== selected.tokens || exact > budget) throw Error('worker_budget_binding');
  parentPort.postMessage({ok: true, result: {...selected, context, context_sha256: hash(context), native_tokens,
    feature_ms, selection_and_format_ms: performance.now() - start, counter: counter.stats()}});
} catch (error) {parentPort.postMessage({ok: false, reason: error.message});}
