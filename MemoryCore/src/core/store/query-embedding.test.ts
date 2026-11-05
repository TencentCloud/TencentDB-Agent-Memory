import { test } from 'vitest';
import assert from 'node:assert/strict';
import {embedQuery} from './query-embedding.js';
import {executeConversationSearch} from '../tools/conversation-search.js';
import {executeMemorySearch} from '../tools/memory-search.js';
import type {EmbeddingService} from './embedding.js';

function fixture(run=async()=>new Float32Array([1,0])) {
 let calls=0;
 const service={embed:async()=>{calls++;return run();},getDimensions:()=>2,getProviderInfo:()=>({provider:'test',model:'test'})} as unknown as EmbeddingService;
 return {service,count:()=>calls};
}
test('same query coalesces in flight and reuses completed vectors without sharing mutable arrays',async()=>{
 let release:any;
 const f=fixture(()=>new Promise<Float32Array>(r=>release=r));
 const pending=Array.from({length:8},()=>embedQuery(f.service,'same question'));
 await Promise.resolve();assert.equal(f.count(),1);release(new Float32Array([1,0]));
 const vectors=await Promise.all(pending);vectors[0][0]=9;
 assert.equal(vectors[1][0],1);assert.equal((await embedQuery(f.service,'same question'))[0],1);assert.equal(f.count(),1);
});
test('different service instances, exact text and timeout options do not share computations',async()=>{
 const a=fixture(),b=fixture();
 await embedQuery(a.service,'query');await embedQuery(b.service,'query');
 await embedQuery(a.service,'query ');await embedQuery(a.service,'query',{timeoutMs:10});await embedQuery(a.service,'query',{timeoutMs:20});
 assert.equal(a.count(),4);assert.equal(b.count(),1);
});
test('expired vectors are recomputed; cache stays bounded',async()=>{
 const f=fixture(),original=Date.now;
 let now=original();Date.now=()=>now;
 try {
  await embedQuery(f.service,'ttl');now+=29999;await embedQuery(f.service,'ttl');assert.equal(f.count(),1);
  now++;await embedQuery(f.service,'ttl');assert.equal(f.count(),2);
  for(let i=0;i<128;i++)await embedQuery(f.service,`bounded-${i}`);
  const before=f.count();await embedQuery(f.service,'overflow');await embedQuery(f.service,'overflow');assert.equal(f.count(),before+2);
 }finally{Date.now=original;}
});
test('failed computations release all waiters and retry; empty vectors are not cached',async()=>{
 let fail=true;
 const f=fixture(async()=>{if(fail)throw Error('temporary failure');return new Float32Array([1,0]);});
 const settled=await Promise.allSettled(Array.from({length:8},()=>embedQuery(f.service,'retry')));
 assert.ok(settled.every(r=>r.status==='rejected'));assert.equal(f.count(),1);
 fail=false;await embedQuery(f.service,'retry');assert.equal(f.count(),2);
 const empty=fixture(async()=>new Float32Array());await embedQuery(empty.service,'empty');await embedQuery(empty.service,'empty');assert.equal(empty.count(),2);
});
test('real L0/L1 search functions reuse one vector and still pass every isolation filter',async()=>{
 const f=fixture(),seen:any[]=[];
 const store:any={isFtsAvailable:()=>false,getCapabilities:()=>({}),
  async searchL0Vector(_v:any,_k:any,_q:any,filter:any){seen.push(['L0',filter]);return [];},
  async searchL1Vector(_v:any,_k:any,_q:any,filter:any){seen.push(['L1',filter]);return [];}};
 const filters=['team-A','team-B'].flatMap(teamId=>['agent-A','agent-B'].map(agentId=>({teamId,agentId,userId:'user',taskId:'task'})));
 await Promise.all(filters.flatMap(filter=>{
  const p={query:'one question',limit:5,filter,vectorStore:store,embeddingService:f.service};
  return [executeConversationSearch(p),executeMemorySearch(p)];
 }));
 assert.equal(f.count(),1);assert.equal(seen.length,8);
 for(const filter of filters)for(const layer of ['L0','L1'])assert.ok(seen.some(([l,f])=>l===layer&&f===filter));
 // Writes retain the original embedding path and never consult the query cache.
 await f.service.embed('one question');assert.equal(f.count(),2);
});
test('native BM25/hybrid paths skip client query embeddings',async()=>{
 const f=fixture();
 for(const caps of [{nativeBm25Search:true},{nativeHybridSearch:true}]){
  const store:any={isFtsAvailable:()=>true,getCapabilities:()=>caps,searchL0Fts:async()=>[],searchL1Fts:async()=>[],searchL0Hybrid:async()=>[],searchL1Hybrid:async()=>[]};
  const p={query:'query',limit:5,vectorStore:store,embeddingService:f.service};await executeConversationSearch(p);await executeMemorySearch(p);
 }
 assert.equal(f.count(),0);
});

test('a reused query vector still observes newly changed store results',async()=>{
 const f=fixture();let revision=1,searches=0;
 const store:any={isFtsAvailable:()=>false,getCapabilities:()=>({}),async searchL0Vector(){
  searches++;
  return [{record_id:`revision-${revision}`,message_text:`new fact ${revision}`,score:1,role:'user',session_id:'session'}];
 }};
 const params={query:'same question',limit:5,vectorStore:store,embeddingService:f.service};
 const before=await executeConversationSearch(params);revision++;
 const after=await executeConversationSearch(params);
 assert.equal(f.count(),1);assert.equal(searches,2);
 assert.equal(before.results[0].id,'revision-1');assert.equal(after.results[0].id,'revision-2');
});
