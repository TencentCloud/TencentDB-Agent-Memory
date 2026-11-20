import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveRetrieveV11} from '../src/v11-runtime.mjs';
import {acquire} from '../src/v11-acquisition-v1-1.mjs';
import {adaptRows} from '../src/v10-data.mjs';
import {withoutEmptyMessages} from '../src/empty-message-adapter.mjs';
test('disabled uses one native call and never loads auxiliary state',async()=>{
 const items=[{id:'base'}];let calls=0;const r=await adaptiveRetrieveV11({client:{search:async(s,q,k)=>{calls++;assert.equal(k,5);return {items};}},loadModel:()=>{throw Error('unused');}});
 assert.equal(calls,1);assert.strictEqual(r.items,items);assert(!r.fallback);
});
test('read failure and metadata timeout use fresh native; base failure propagates',async()=>{
 const client={search:async()=>({items:[{id:'base'}],request_id:'fresh'})};
 for(const patch of [{loadModel:()=>{throw Error('read');}},{loadModel:async()=>({}),loadMapping:()=>new Promise(()=>{}),timeoutMs:10}]){
  const r=await adaptiveRetrieveV11({enabled:true,client,...patch});assert(r.fallback);assert.equal(r.request_id,'fresh');
 }
 await assert.rejects(adaptiveRetrieveV11({client:{search:async()=>{throw Error('base');}}}),/base/);
});
test('uniform opportunity multiplicity does not change selected question IDs',()=>{
 const xs=Array.from({length:40},(_,i)=>({probe_id:'q'+i,key:'k'+i,split:'train',repair:0,novelty:0}));
 assert.deepEqual(acquire(xs,'uniform').map(x=>x.probe_id),acquire([...xs,...Array.from({length:80},(_,i)=>({...xs[39],key:'extra'+i}))],'uniform').map(x=>x.probe_id));
});
test('an unknown internal dataset crosses the canonical adapter without public schema fields',()=>{
 const s={subject_id:'private-task',group_id:'project',dataset:'internal-code',split:'train',
 messages:[{id:'turn',session_id:'s',role:'user',content:'Keep the API signature.',date:'2026-01-01'}],
 probes:[{id:'q',query:'What is fixed?',answer:'signature',gold_ids:['turn'],exclusion:null}]};
 const result=adaptRows([s],{adapter:'normalized',split:'train'});assert.equal(result.length,1);assert.equal(result[0].subject.dataset,'internal-code');
 assert.notEqual(result[0].subject.messages[0].id,'turn');
 assert.throws(()=>adaptRows([s],{adapter:'normalized',split:'protected_test'}));
});
test('empty non-gold messages are audited, but empty gold is never silently dropped',()=>{
 const s={subject_id:'s',messages:[{id:'a',content:''},{id:'b',content:' '}],probes:[{gold_ids:[]}]};
 const r=withoutEmptyMessages([s]);assert.equal(r.skipped.length,1);assert.equal(r.subjects[0].messages[0].content,' ');
 assert.throws(()=>withoutEmptyMessages([{...s,probes:[{gold_ids:['a']}]}]),/empty_gold/);
});
