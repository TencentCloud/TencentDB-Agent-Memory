import {hash} from './adapters.mjs';

export function rankCandidates(items,scores,alpha=1){
 if(!Array.isArray(items)||items.length>64||new Set(items.map(x=>x.id)).size!==items.length||scores.length!==items.length||![0,.5,.75,1].includes(alpha))throw Error('candidate_schema');
 const scored=new Map(scores.map(x=>[x.id,x.score]));if(scored.size!==items.length||items.some(x=>typeof x.content!=='string'||!Number.isFinite(scored.get(x.id))))throw Error('score_schema');
 const order=items.map((x,i)=>({id:x.id,i,score:scored.get(x.id)})).sort((a,b)=>b.score-a.score||a.i-b.i),rank=new Map(order.map((x,i)=>[x.id,i]));
 return items.map((item,i)=>({item,i,value:(1-alpha)/(61+i)+alpha/(61+rank.get(item.id))})).sort((a,b)=>b.value-a.value||a.i-b.i).map(x=>x.item);
}

export function selectFixed({items,scores,cost,budget,alpha=1,maxItems=5}){
 if(!Number.isInteger(budget)||budget<cost([])||maxItems!==5)throw Error('selection_budget');
 const selected=[];for(const item of rankCandidates(items,scores,alpha)){if(selected.length===maxItems)break;if(cost([...selected,item])<=budget)selected.push(item);}
 return {items:selected,tokens:cost(selected),budget_tokens:budget};
}

const stop=new Set('a an the i my me we you your how what when where which who why is are was were do did does have has had to of in on at for from and or it this that many much any can could would should since about'.split(' '));
const words=s=>new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>w.length>2&&!stop.has(w)));
// A versioned fixed-budget reproduction of the prior beam objective; not a new algorithm.
export function selectBeam({query,items,scores,mapping,cost,budget,alpha=.75,beamWidth=4,maxStates=1280,timeoutMs=1000}){
 if(beamWidth!==4||maxStates!==1280||!(timeoutMs>0&&timeoutMs<=1000)||!Number.isInteger(budget)||cost([])>budget)throw Error('beam_bounds');
 const start=performance.now(),order=rankCandidates(items,scores,alpha),rank=new Map(order.map((x,i)=>[x.id,i])),pool=new Set(items.map(x=>x.id));
 const vocab=new Map(items.map(x=>[x.id,words(x.content)])),facets=[...words(query)].map(w=>({w,n:items.filter(x=>vocab.get(x.id).has(w)).length})).filter(x=>x.n).sort((a,b)=>a.n-b.n||a.w.localeCompare(b.w)).slice(0,8).map(x=>x.w);
 const relOrder=rankCandidates(items,scores,1),relevance=new Map(relOrder.map((x,i)=>[x.id,1/(1+i)])),groups=new Map();
 for(const item of order){const m=mapping.accepted[item.id];if(!m||m.content_hash!==hash(item.content)||!mapping.turns[m.turn_id]?.includes(item.id))throw Error('provenance_schema');if(!groups.has(m.turn_id))groups.set(m.turn_id,[]);groups.get(m.turn_id).push(item);}
 const bundles=[...groups.entries()].filter(([t])=>mapping.turns[t].every(id=>pool.has(id))).map(([,xs])=>xs);
 const value=xs=>xs.reduce((n,x)=>n+relevance.get(x.id),0)+.5*facets.filter(w=>xs.some(x=>vocab.get(x.id).has(w))).length/Math.max(1,facets.length)+.2*Math.min(3,new Set(xs.map(x=>mapping.accepted[x.id].session_id)).size);
 const cmp=(a,b)=>b.value-a.value||a.tokens-b.tokens||a.items.map(x=>x.id).join('|').localeCompare(b.items.map(x=>x.id).join('|'));
 let beam=[{items:[],tokens:cost([]),value:0}],best=beam[0],states=0;
 for(let depth=0;depth<5;depth++){const next=new Map();for(const state of beam)for(const bundle of bundles){if(state.items.length+bundle.length>5||state.items.some(x=>bundle.some(y=>x.id===y.id)))continue;if(++states>maxStates||performance.now()-start>timeoutMs)throw Error('beam_limit');
   const xs=[...state.items,...bundle].sort((a,b)=>rank.get(a.id)-rank.get(b.id)),tokens=cost(xs);if(tokens>budget)continue;const s={items:xs,tokens,value:value(xs)};next.set(xs.map(x=>x.id).join('|'),s);if(cmp(s,best)<0)best=s;
  }beam=[...next.values()].sort(cmp).slice(0,beamWidth);if(!beam.length)break;}
 return {...best,budget_tokens:budget,states,selection_ms:performance.now()-start};
}
