const tokens=s=>new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(x=>x.length>2));
const overlap=(a,b)=>{const bs=new Set(b);return a.filter(x=>bs.has(x)).length/Math.max(1,new Set([...a,...b]).size);};
// Public-only features; no question category, reference, gold membership or QA label.
export function outcomeFeatures({query,items,scores,mapping,native,candidate,cost}){
 if(items.length>64||native.length>5||candidate.length>5||typeof query!=='string')throw Error('outcome_input');
 const q=tokens(query),text=candidate.map(x=>x.content).join('\n'),v=tokens(text),ranked=[...scores].sort((a,b)=>b.score-a.score),scoreMap=new Map(scores.map(x=>[x.id,x.score]));
 const selectedScores=candidate.map(x=>scoreMap.get(x.id)).filter(Number.isFinite),selectedTurns=new Set(candidate.map(x=>mapping.accepted[x.id]?.turn_id));
 if(candidate.some(x=>!mapping.accepted[x.id]))throw Error('outcome_provenance');
 const poolIds=new Set(items.map(x=>x.id)),allIds=new Set(candidate.map(x=>x.id));
 const partial=[...selectedTurns].filter(t=>!mapping.turns[t]?.every(id=>allIds.has(id))).length;
 return [1,Math.min(query.length,500)/500,Math.tanh((ranked[0]?.score??0)/10),Math.tanh(((ranked[0]?.score??0)-(ranked[1]?.score??0))/10),candidate.length/5,cost(candidate)/Math.max(1,cost(native)),overlap(native.map(x=>x.id),candidate.map(x=>x.id)),[...q].filter(x=>v.has(x)).length/Math.max(1,q.size),new Set(candidate.map(x=>mapping.accepted[x.id].session_id)).size/5,partial/5,Number(/\b(latest|current|changed|update|now|instead|previous|before|after)\b/i.test(query)),Number(/\b(all|both|compare|between|different|list|how many)\b/i.test(query)),selectedScores.length?Math.tanh(selectedScores.reduce((n,x)=>n+x,0)/selectedScores.length/10):0,Math.min(1,[...selectedTurns].filter(t=>mapping.turns[t]?.every(id=>poolIds.has(id))).length/5)];
}
function solve(a,b){const n=b.length,m=a.map((r,i)=>[...r,b[i]]);for(let k=0;k<n;k++){let p=k;for(let i=k+1;i<n;i++)if(Math.abs(m[i][k])>Math.abs(m[p][k]))p=i;if(Math.abs(m[p][k])<1e-12)throw Error('singular_model');[m[k],m[p]]=[m[p],m[k]];const d=m[k][k];for(let j=k;j<=n;j++)m[k][j]/=d;for(let i=0;i<n;i++)if(i!==k){const f=m[i][k];for(let j=k;j<=n;j++)m[i][j]-=f*m[k][j];}}return m.map(r=>r[n]);}
export function fitOutcomePolicy(rows,actions,{ridge=1,consensusOnly=false}={}){
 if(rows.length>4096||rows.length<10||actions.length>8||new Set(actions).size!==actions.length||ridge!==1)throw Error('fit_bounds');
 const models={};let used=0,discarded=0;for(const action of actions){const eligible=rows.filter(r=>r.action===action&&(!consensusOnly||r.consensus===true));discarded+=rows.filter(r=>r.action===action).length-eligible.length;if(eligible.length<10){models[action]=null;continue;}
  const dim=14,a=Array.from({length:dim},(_,i)=>Array.from({length:dim},(_,j)=>i===j?ridge:0)),b=Array(dim).fill(0);for(const r of eligible){if(r.x.length!==dim||r.x.some(x=>!Number.isFinite(x))||![0,1].includes(r.base_correct)||![0,1].includes(r.correct))throw Error('fit_schema');
   // Full-information offline reward: correctness gain, explicit damage penalty, token cost.
   const gain=r.correct-r.base_correct,harm=r.base_correct===1&&r.correct===0?1:0,y=gain-2*harm-.02*(r.x[5]-1);for(let i=0;i<dim;i++){b[i]+=r.x[i]*y;for(let j=0;j<dim;j++)a[i][j]+=r.x[i]*r.x[j];}used++;
  }models[action]={weights:solve(a,b),training_rows:eligible.length};
 }
 return {version:'ac-outcome-ridge-v9.0',actions,models,ridge,consensus_only:consensusOnly,used_rows:used,discarded_rows:discarded,max_features:14,accept_prediction_gt:0,calibrated:false};
}
export function chooseOutcome(model,features,{enabled=true,accept=true}={}){
 if(!enabled)return {action:'native_k5',reason:'disabled'};if(!accept)return {action:'native_k5',reason:'not_certified'};
 if(model?.version!=='ac-outcome-ridge-v9.0'||model.actions.length>8||JSON.stringify(model).length>32768)throw Error('outcome_model');
 let best={action:'native_k5',prediction:0,reason:'nonpositive_predicted_utility'};for(const action of model.actions){const head=model.models[action];if(!head)continue;const x=features[action];if(!Array.isArray(x)||x.length!==14||x.some(v=>!Number.isFinite(v))||head.weights.length!==14||head.weights.some(v=>!Number.isFinite(v)))throw Error('outcome_features');const prediction=x.reduce((n,v,i)=>n+v*head.weights[i],0);if(prediction>best.prediction)best={action,prediction,reason:'positive_predicted_utility'};}return best;
}
export async function guardedOutcome({enabled=false,loadModel,work,baseline,timeoutMs=1000}){
 if(!enabled)return {...await baseline(),fallback:false,mode:'disabled'};let timer;try{const result=await Promise.race([Promise.resolve().then(async()=>work(await loadModel())),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('outcome_timeout')),timeoutMs);})]);return {...result,fallback:false};}catch(e){return {...await baseline(),fallback:true,fallback_reason:e.message};}finally{clearTimeout(timer);}
}
