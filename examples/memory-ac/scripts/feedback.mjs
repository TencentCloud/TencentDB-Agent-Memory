import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {prepareV9} from '../src/v9-context.mjs';
import {buildSlates,slateFeatures} from '../src/v11-slate.mjs';
import {removalOpportunities} from '../src/v11-acquisition.mjs';
import {acquire} from '../src/v11-acquisition-v1-1.mjs';
import {view} from '../src/ten-rounds-data-v1-2.mjs';
const rows=async f=>(await readFile(f,'utf8')).trim().split('\n').map(JSON.parse);
const [phase,...args]=process.argv.slice(2);
if(phase==='collect'){
 const [planFile,labelFile,out]=args;if(!out)throw Error('collect PLAN_JSON LABELS_JSONL NEW_PAIRS_JSONL');
 const plan=JSON.parse(await readFile(planFile,'utf8')),labels=new Map((await rows(labelFile)).map(x=>[x.probe_id+'|'+x.mode,x.correct])),pairs=[...plan.qa_pairs];
 for(const arm of ['active','uniform'])for(const o of plan.arms[arm]){
  const modes=['original','control_removed','support_removed'];const ys=modes.map(m=>labels.get(o.probe_id+'|'+o.key+':'+m));
  if(ys.some(x=>![0,1].includes(x)))throw Error('missing_intervention_label');
  if(ys[0]===1&&ys[1]===1&&ys[2]===0)pairs.push({probe_id:o.probe_id,group_id:o.group_id,dataset:o.dataset,split:'train',source:arm,
    positive:o.features.control_removed,negative:o.features.support_removed});
 }
 await writeFile(out,pairs.map(JSON.stringify).join('\n')+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'pass',pairs:pairs.length,auto_deploy:false}));
}else if(phase==='prepare'){
 const [bundleFile,labelFile,modelFile,out]=args;if(!out)throw Error('prepare BUNDLE_JSONL PRIMITIVE_LABELS_JSONL MODELS_JSON NEW_OUT_DIRECTORY');
 const bundle=await rows(bundleFile),labels=new Map((await rows(labelFile)).map(x=>[x.probe_id+'|'+x.mode,x.correct]));
 const model=JSON.parse(await readFile(modelFile,'utf8')),opportunities=[],qaPairs=[],data=new Map();
 if(bundle.length>10000||bundle.some(r=>r.task.split!=='train'))throw Error('training_only');
 const eligibility=[];
 for(const r of bundle){
  const d=prepareV9(r);data.set(r.task.probe_id,d);
  const cs=buildSlates({query:r.task.query,items:r.items,scores:r.scores,mapping:r.mapping,native_items:r.native_items,cost:d.cost,budget:d.budget,heads:model.heads});
  const distinct=[...new Map(cs.map(c=>[d.render(c.items),c])).values()];
  const label=c=>{const y=labels.get(r.task.probe_id+'|'+c.action);if(![0,1].includes(y))throw Error('missing_primitive_label');return y;};
  for(const p of distinct.filter(c=>label(c)===1))for(const n of distinct.filter(c=>label(c)===0))qaPairs.push({probe_id:r.task.probe_id,group_id:r.task.group_id,dataset:r.task.dataset,split:'train',source:'qa',positive:p.x,negative:n.x});
  let count=0;
  for(const c of distinct.filter(c=>label(c)===1)){
   for(const o of removalOpportunities({probeId:r.task.probe_id,items:c.items,mapping:r.mapping,goldIds:r.ref.gold_ids,cost:d.cost})){
    const score=new Map(r.scores.map(s=>[s.id,s.score]));const avg=ids=>ids.reduce((n,id)=>n+score.get(id),0)/ids.length;
    const variants={original:c.items,control_removed:o.control_items,support_removed:o.support_items};
    opportunities.push({...o,probe_id:r.task.probe_id,group_id:r.task.group_id,dataset:r.task.dataset,split:'train',repair:1-label(cs[0]),
     novelty:avg(o.control_removed_ids)-avg(o.support_removed_ids),variants,
     features:Object.fromEntries(Object.entries(variants).map(([name,selected])=>[name,slateFeatures({query:r.task.query,items:r.items,scores:r.scores,mapping:r.mapping,nativeIds:r.native_items.map(x=>x.id),selected,tokens:d.cost(selected),budget:d.budget})]))});count++;
   }
  }
  eligibility.push({probe_id:r.task.probe_id,opportunities:count,matched:count>0});
 }
 const arms={active:acquire(opportunities,'active'),uniform:acquire(opportunities,'uniform')};
 const unique=[...new Map([...arms.active,...arms.uniform].map(o=>[o.key,o])).values()],views=[];
 for(const o of unique)for(const [name,items]of Object.entries(o.variants))views.push(view(data.get(o.probe_id),o.key+':'+name,{items},{intervention:name,signal_type:'matched_source_removal'}));
 await mkdir(out);await writeFile(out+'/views.jsonl',views.map(JSON.stringify).join('\n')+'\n',{flag:'wx'});
 await writeFile(out+'/references.jsonl',bundle.map(r=>JSON.stringify(r.ref)).join('\n')+'\n',{flag:'wx'});
 await writeFile(out+'/plan.json',JSON.stringify({version:'ac-delivery-feedback-v1',qa_pairs:qaPairs,arms,eligibility,opportunities:opportunities.length},null,2),{flag:'wx'});
 console.log(JSON.stringify({status:'pass',train_questions:bundle.length,matched:eligibility.filter(x=>x.matched).length,views:views.length}));
}else throw Error('Usage: feedback.mjs prepare|collect ...; evaluation only, never imported by runtime');
