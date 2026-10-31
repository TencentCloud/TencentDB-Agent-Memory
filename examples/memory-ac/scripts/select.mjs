import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {prepareV9} from '../src/v9-context.mjs';
import {buildSlates,chooseSlate} from '../src/v11-slate.mjs';
import {view} from '../src/ten-rounds-data-v1-2.mjs';
import {hash} from '../src/adapters.mjs';
const [bundlePath,modelPath,out]=process.argv.slice(2);
if(!out || !resolve(out).startsWith(resolve('.')+sep))throw Error('Usage: select.mjs BUNDLE MODELS NEW_OUT_DIRECTORY');
const records=(await readFile(bundlePath,'utf8')).trim().split('\n').map(JSON.parse), model=JSON.parse(await readFile(modelPath,'utf8'));
if(!records.length||records.length>10000)throw Error('record_capacity');
await mkdir(out);
const views=[];
for(const r of records){
 if(!['train','development','calibration'].includes(r.task.split))throw Error('protected_or_unknown_split');
 const d=prepareV9(r),candidates=buildSlates({query:r.task.query,items:r.items,scores:r.scores,mapping:r.mapping,native_items:r.native_items,cost:d.cost,budget:d.budget,heads:model.heads});
 views.push(view(d,'native_k5',{items:r.native_items},{fallback:false}));
 for(const c of candidates)views.push(view(d,c.action,c,{fallback:false,auxiliary:true}));
 for(const mode of ['slate_qa','slate_active','slate_uniform','slate_sham','slate_active_ungated']){
  const c=chooseSlate(model.models[mode==='slate_active_ungated'?'slate_active':mode],candidates,{stable:mode!=='slate_active_ungated'});
  views.push(view(d,mode,c,{routed_action:c.routed_action,decisions:c.decision,fallback:false,auxiliary:true,labels_used_at_decision:false}));
 }
}
await writeFile(out+'/views.jsonl',views.map(JSON.stringify).join('\n')+'\n',{flag:'wx'});
await writeFile(out+'/references.jsonl',records.map(r=>JSON.stringify(r.ref)).join('\n')+'\n',{flag:'wx'});
await writeFile(out+'/summary.json',JSON.stringify({status:'pass',questions:records.length,views:views.length,
 model_sha256:hash(await readFile(modelPath)),bundle_sha256:hash(await readFile(bundlePath)),latency_claim:false},null,2),{flag:'wx'});
