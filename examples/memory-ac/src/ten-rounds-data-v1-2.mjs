import {hash} from './adapters.mjs';
import {evidenceMetrics} from './metrics.mjs';
// Compatibility function for the frozen generic ingest command, without research-directory loaders.
export function view(d,mode,selected,extra={}) {
  const context=d.render(selected.items);
  return {...d.task,mode,...evidenceMetrics(d.ref.gold_ids,selected.items,d.mapping.turns,!!d.task.exclusion),
    selected_ids:selected.items.map(x=>x.id),context,context_sha256:hash(context),tokens:d.cost(selected.items),
    injected_count:selected.items.length,k:selected.items.length,budget_tokens:mode==='native_k5'?null:d.budget,
    latency_ms:null,selection_ms:selected.selection_ms??null,...extra};
}
