import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fitSlate} from '../src/v11-slate.mjs';
import {hash} from '../src/adapters.mjs';
import {compare} from '../src/metrics.mjs';
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const rows=async f=>(await readFile(f,'utf8')).trim().split('\n').map(JSON.parse);
const provenance=await json('source-provenance.json');
for(const [file,sha]of Object.entries(provenance.files))assert.equal(hash(await readFile(file)),sha,file);
const pairs=await rows('evidence/feedback-pairs.jsonl'),model=await json('evidence/models.json');
for(const variant of ['qa','active','uniform','sham'])assert.deepEqual(fitSlate(pairs,variant),model.models['slate_'+variant]);
const allIds=new Set();let questions=0,views=0,train=0,contrasts=0;
for(const cohort of ['longmem','beam-100K','beam-500K','beam-1M']){
 const cases=await rows(`evidence/${cohort}-cases.jsonl`),summary=await json(`evidence/${cohort}-summary.json`);
 assert.equal(new Set(cases.map(c=>c.probe_id+'|'+c.mode)).size,cases.length);
 for(const c of cases){assert([0,1].includes(c.correct));assert(!('context'in c));assert(!('query'in c));assert(!('answer'in c));
  if(c.mode!=='native_k5'){assert(c.tokens<=c.budget_tokens);assert(c.k<=5);}}
 for(const [split,part]of Object.entries(summary.splits)){
  const modes=Object.groupBy(cases.filter(c=>c.split===split),c=>c.mode);
  for(const [mode,metrics]of Object.entries(part.modes)){
   const cs=modes[mode];assert.equal(cs.length,metrics.n);assert.equal(cs.reduce((n,c)=>n+c.correct,0),metrics.correct);
   assert(Math.abs(cs.reduce((n,c)=>n+c.tokens,0)/cs.length-metrics.mean_tokens)<1e-8);
   assert.equal(cs.filter(c=>c.complete!==null).length,metrics.eligible);
  }
  const native=modes.native_k5;questions+=native.length;if(split==='train')train+=native.length;
  for(const c of native){assert(!allIds.has(c.probe_id));allIds.add(c.probe_id);}
  if(split!=='train')for(const base of ['qwen_fixed','slate_qa','slate_uniform']){
   const scored=xs=>xs.map(c=>({...c,complete:c.correct}));
   const recomputed=compare(scored(modes[base]),scored(modes.slate_active),10000);
   assert.deepEqual(recomputed,part.modes.slate_active.qa_comparisons[base]);contrasts++;
  }
 }
 views+=cases.length;
}
assert.equal(questions,828);assert.equal(train,272);assert.equal(views,7452);
console.log(JSON.stringify({status:'pass',questions,training_questions:train,evaluation_questions:questions-train,method_views:views,
 refitted_models:4,recomputed_primary_bootstrap_contrasts:contrasts,original_source_files_verified:Object.keys(provenance.files).length,
 new_model_calls:0,semantic_labels_rejudged:false,meaning:'Arithmetic, parameter-refit and frozen-source verification; not a new model benchmark.'},null,2));
