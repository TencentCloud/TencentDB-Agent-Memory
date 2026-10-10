import {hash} from './adapters.mjs';
import {encoding} from './experiment-gateway.mjs';
import {formatConversationSearchResponse} from '../vendor/TencentDB-Agent-Memory/MemoryCore/src/core/tools/conversation-search.ts';
// Package adapter: no implicit historical data directories. Same frozen formatter and budget.
export function prepareV9(record) {
  const d={...record}, cache=new Map();
  d.render=items=>(record.context_prefix??'')+formatConversationSearchResponse({strategy:'fts',total:items.length,
    results:items.map(x=>{const m=record.mapping.accepted[x.id]; if(hash(x.content)!==m?.content_hash) throw Error('content_binding');
      return {...x,session_key:m.session_id,recorded_at:m.source_date};})});
  d.cost=items=>{const key=JSON.stringify(items.map(x=>x.id));if(!cache.has(key))cache.set(key,encoding.encode(d.render(items),'all').length);return cache.get(key);};
  d.budget=Math.floor(.8*d.cost(record.native_items));return d;
}
