import {parentPort, workerData as input} from 'node:worker_threads';
import {hash} from './adapters.mjs';
import {buildSlates, chooseSlate} from './v11-slate.mjs';
import {exactTokenCounter} from './v9-token-cache.mjs';
import {getEncoding} from '../vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/js-tiktoken/dist/index.js';
import {formatConversationSearchResponse} from '../vendor/TencentDB-Agent-Memory/MemoryCore/src/core/tools/conversation-search.ts';
try {
  const allowed = new Set(['query', 'items', 'native_items', 'scores', 'mapping', 'context_prefix', 'model', 'mode']);
  if (Object.keys(input).some(k => !allowed.has(k)) || !['slate_qa', 'slate_active', 'slate_uniform', 'slate_sham', 'slate_active_ungated'].includes(input.mode)) throw Error('v11_worker_public_schema');
  if (typeof input.query !== 'string' || input.query.length > 20000 || input.items.length > 64 || input.native_items.length > 5) throw Error('v11_worker_bounds');
  if (input.model?.version !== 'v11-model-bundle' || JSON.stringify(input.model).length > 160000) throw Error('v11_model_bundle');
  for (const x of [...input.items, ...input.native_items]) if (hash(x.content) !== input.mapping.accepted[x.id]?.content_hash) throw Error('v11_worker_content_binding');
  const prefix = input.context_prefix ?? ''; if (typeof prefix !== 'string' || prefix.length > 2048) throw Error('v11_prefix');
  const encoding = getEncoding('cl100k_base'), counter = exactTokenCounter(encoding), cache = new Map();
  const render = items => prefix + formatConversationSearchResponse({strategy: 'fts', total: items.length,
    results: items.map(x => ({...x, session_key: input.mapping.accepted[x.id].session_id, recorded_at: input.mapping.accepted[x.id].source_date}))});
  const cost = xs => {const k = xs.map(x => x.id).join('|'); if (!cache.has(k)) cache.set(k, counter.count(render(xs))); return cache.get(k);};
  const start = performance.now(), nativeTokens = cost(input.native_items), budget = Math.floor(.8 * nativeTokens);
  const candidates = buildSlates({...input, cost, budget, heads: input.model.heads});
  const model = input.model.models[input.mode === 'slate_active_ungated' ? 'slate_active' : input.mode];
  const selected = chooseSlate(model, candidates, {stable: input.mode !== 'slate_active_ungated'});
  const context = render(selected.items), exact = encoding.encode(context, 'all').length;
  if (selected.tokens !== exact || exact > budget) throw Error('v11_worker_budget_binding');
  parentPort.postMessage({ok: true, result: {items: selected.items, tokens: exact, budget_tokens: budget, context,
    context_sha256: hash(context), native_tokens: nativeTokens, routed_action: selected.routed_action,
    decision: selected.decision, stable: selected.stable, calibrated: false, selection_and_format_ms: performance.now() - start, counter: counter.stats()}});
} catch (error) {parentPort.postMessage({ok: false, reason: error.message});}
