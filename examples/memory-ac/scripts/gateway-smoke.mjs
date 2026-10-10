import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
import {ExperimentGateway} from '../src/experiment-gateway.mjs';
import {adaptiveRetrieveV11} from '../src/v11-runtime.mjs';
import {prepareV9} from '../src/v9-context.mjs';
import {buildSlates,chooseSlate} from '../src/v11-slate.mjs';
const out=resolve('runs/gateway-smoke-'+Date.now());await mkdir(out,{recursive:true});
const gateway=new ExperimentGateway(out+'/runtime'),model=JSON.parse(await readFile('evidence/models.json','utf8')),checks=[];
const subject={subject_id:'synthetic-wiring-only',group_id:'smoke',dataset:'smoke',split:'train',probes:[],
 messages:Array.from({length:12},(_,i)=>({id:'m'+i,session_id:'s',role:i%2?'assistant':'user',date:'2026-01-01T00:00:00Z',
 content:`Project compiler constraint ${i}: keep the existing project compiler interface stable. This is a smoke fixture for wiring, not benchmark evidence.`}))};
try{
 await gateway.start(0);const mapping=await gateway.ingest(subject),scope=mapping.scope,query='Project compiler constraint';
 const client=gateway.client,loadMapping=async()=>({mapping,context_prefix:''}),loadModel=async()=>model;
 const score=async(q,items)=>({scores:items.map((x,i)=>({id:x.id,score:items.length-i})),input_tokens:0});
 const runtime={score,stop:async()=>{}};
 const options={enabled:true,client,scope,query,loadMapping,loadModel,runtime};
 const native=await client.search(scope,query,5);assert(native.items.length>0);
 const disabled=await adaptiveRetrieveV11({...options,enabled:false,loadModel:()=>{throw Error('must_not_read');}});
 assert.deepEqual(disabled.items,native.items);assert(!disabled.fallback);checks.push({case:'disabled',pass:true,k:disabled.items.length});
 const normal=await adaptiveRetrieveV11(options);assert(!normal.fallback);assert(normal.tokens<=normal.budget_tokens);
 const pool=await client.search(scope,query,32),scores=(await score(query,pool.items)).scores;
 const d=prepareV9({items:pool.items,native_items:native.items,scores,mapping});
 const chosen=chooseSlate(model.models.slate_active,buildSlates({query,items:pool.items,native_items:native.items,scores,mapping,cost:d.cost,budget:d.budget,heads:model.heads}));
 assert.equal(normal.context,d.render(chosen.items));checks.push({case:'enabled_equals_offline',pass:true,k:normal.items.length,tokens:normal.tokens,budget_tokens:normal.budget_tokens});
 const faults=[
  ['read_failure',{loadModel:()=>{throw Error('injected_read_failure');}}],
  ['metadata_timeout',{timeoutMs:40,loadMapping:()=>new Promise(()=>{})}],
  ['corrupt_model',{loadModel:async()=>({})}],
  ['corrupt_mapping',{loadMapping:async()=>({mapping:{accepted:{},turns:{}}})}],
  ['cpu_hang',{workerTimeoutMs:40,workerFactory:()=>new Worker('while(true){}',{eval:true})}],
  ['score_timeout',{timeoutMs:500,runtime:{score:()=>new Promise(()=>{}),stop:async()=>{}}}]
 ];
 for(const [name,patch]of faults){const r=await adaptiveRetrieveV11({...options,...patch});assert(r.fallback,name);assert.deepEqual(r.items,native.items,name);assert.notEqual(r.request_id,native.request_id);checks.push({case:name,pass:true,k:r.items.length,fallback:true,reason:r.fallback_reason,total_ms:r.total_ms});}
 await assert.rejects(adaptiveRetrieveV11({...options,enabled:false,client:{search:async()=>{throw Error('base_failed');}}}),/base_failed/);
 checks.push({case:'base_error_propagates',pass:true});
 await writeFile(out+'/summary.json',JSON.stringify({status:'pass',checks,actual_memorycore:true,actual_qwen:false,model_calls:0,
  scope:'Synthetic wiring and failure tests only. Historical 72-request public-data Qwen benchmark remains separate.'},null,2),{flag:'wx'});
 console.log(JSON.stringify({status:'pass',checks:checks.length,out,synthetic_only:true}));
}catch(e){await writeFile(out+'/FAILED.json',JSON.stringify({status:'fail',error:e.stack,checks}),{flag:'wx'});throw e;}
finally{await gateway.stop();}
