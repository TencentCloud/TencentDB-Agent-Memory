/** Actual MemoryCore indexing and bounded read-only retrieval. No labels imported. */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { VectorStore, buildFtsQuery } from '../../MemoryCore/src/core/store/sqlite/memory-store.js';
import { retrieveWithBudget, type BudgetPolicy, type BudgetHit } from '../../MemoryCore/src/core/feedback/retrieval-budget.js';
import type { MemoryRecord } from '../../MemoryCore/src/core/store/types.js';
import type { EpisodicMetadata } from '../../MemoryCore/src/core/record/l1-writer.js';

interface Memory {id:string; source_id:string; content:string; content_sha256:string; session_id:string; timestamp_original:string}
interface Collection {id:string; split:string; memories:Memory[]; queries:{id:string;question:string}[]}
const [phase, dataArg, outArg, policyArg] = process.argv.slice(2);
if (!['collect','test'].includes(phase ?? '') || !dataArg || !outArg)
  throw Error('usage: store-runner.ts collect|test inputs.json NEW_OUTPUT_DIR [policy.json]');
const out = resolve(outArg); if (existsSync(out)) throw Error('output_exists');
const raw=readFileSync(resolve(dataArg)); if(raw.length>32*1024*1024) throw Error('input_capacity');
const collections=JSON.parse(raw.toString('utf8')) as Collection[];
if(!Array.isArray(collections)||collections.length>32) throw Error('collection_capacity');
const policy: BudgetPolicy | undefined = phase==='test' ? JSON.parse(readFileSync(resolve(policyArg!),'utf8')).policy : undefined;
mkdirSync(out,{recursive:true});
const rows: unknown[]=[]; const indexRows:unknown[]=[];
const zero={model_calls:0,http_requests:0,token_usage:null,token_status:'not_applicable_no_model'};
const hash=(b:string)=>createHash('sha256').update(b).digest('hex');
let failure: {status:string;stage:string;error:string} | null = null;
try {
for (const c of collections) {
  if(phase==='test' && c.split!=='test') continue;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(c.id)||c.memories.length>1024||c.queries.length>128) throw Error('collection_contract');
  const path=join(out,c.id+'.sqlite'); let warnings=0;
  const logger={debug(){},info(){},warn(){warnings++;},error(){warnings++;}};
  const store=new VectorStore(path,0,logger); const indexStart=performance.now();
  store.init();
  if(store.isDegraded()||!store.isFtsAvailable()) throw Error('memorycore_fts_unavailable');
  const seen=new Set<string>(); let totalBytes=0;
  try {
    for(const m of c.memories) {
      if(seen.has(m.id)||hash(m.content)!==m.content_sha256||Buffer.byteLength(m.content)>8192) throw Error('memory_contract');
      seen.add(m.id); totalBytes+=Buffer.byteLength(m.content);
      if(totalBytes>4*1024*1024) throw Error('source_capacity');
      const time='2020-01-01T00:00:00.000Z';
      const metadata:EpisodicMetadata & {source_id:string;source_timestamp:string} =
        {source_id:m.source_id,source_timestamp:m.timestamp_original};
      const record: MemoryRecord={id:m.id,content:m.content,version:1,type:'episodic',priority:50,scene_name:'',
        source_message_ids:[m.source_id],metadata,
        timestamps:[time],createdAt:time,updatedAt:time,sessionKey:c.id,sessionId:m.session_id,
        teamId:'public-evaluation',userId:c.id,agentId:'memory-method',taskId:c.id};
      if(!store.upsertL1(record,undefined)) throw Error('memorycore_write_failed');
    }
    const indexMs=performance.now()-indexStart;
    const actual=store.getRawDb().prepare('SELECT record_id, content FROM l1_records ORDER BY record_id').all() as {record_id:string;content:string}[];
    if(actual.length!==c.memories.length||actual.some(r=>!seen.has(r.record_id)||!c.memories.some(m=>m.id===r.record_id&&m.content===r.content))) throw Error('index_roundtrip_mismatch');
    indexRows.push({collection_id:c.id,split:c.split,expected_entries:c.memories.length,actual_entries:actual.length,
      exact_roundtrip:true,index_ms:indexMs,source_bytes:totalBytes,indexed_content_sha256:hash(JSON.stringify(actual)),...zero});
    const search=(question:string,k:number):BudgetHit[]=>{
      if(Buffer.byteLength(question)>4096) throw Error('query_capacity');
      const q=buildFtsQuery(question); if(!q) return [];
      const before=warnings;
      const hits=store.searchL1Fts(q,k);
      if(warnings!==before) throw Error('memorycore_retrieval_error');
      return hits.map(h=>({id:h.record_id,content:h.content,score:h.score}));
    };
    for(let qi=0;qi<c.queries.length;qi++) {
      const query=c.queries[qi]!;
      if(phase==='collect') {
        const start=performance.now();
        const baseline=search(query.question,5); const expanded=search(query.question,12);
        rows.push({query_id:query.id,collection_id:c.id,split:c.split,baseline,expanded,
          elapsed_ms:performance.now()-start,status:'observed',...zero});
        continue;
      }
      const modes=['baseline','fixed12','candidate','adaptive','forced_error'] as const;
      for(let repeat=0;repeat<5;repeat++) {
        const rotate=(qi+repeat)%modes.length;
        const order=[...modes.slice(rotate),...modes.slice(0,rotate)];
        for(const mode of order) {
          const start=performance.now();
          try {
            const r=mode==='fixed12' ? {hits:search(query.question,12),mode,k:12,auxiliaryCalls:0,
              fallback:false,reason:null,signalType:'fixed_budget',gap:null,elapsedMs:performance.now()-start} :
              await retrieveWithBudget({baseline:()=>search(query.question,5),
                expanded:()=>{if(mode==='forced_error') throw Error('forced');return search(query.question,12);},
                mode:mode==='forced_error'?'candidate':mode,policy});
            rows.push({query_id:query.id,collection_id:c.id,split:'test',mode,repeat,
              status:'observed',injection_id:`${query.id}/${mode}/R${repeat}`,entry_ids:r.hits.map(h=>h.id),
              injected_bytes:Array.from(r.hits).reduce<number>((n,h)=>n+Buffer.byteLength(h.content),0),injected_entries:r.hits.length,
              injection_sha256:hash(JSON.stringify(r.hits)),k:r.k,auxiliary_calls:r.auxiliaryCalls,
              fallback:r.fallback,fallback_reason:r.reason,signal_type:r.signalType,gap:r.gap,
              elapsed_ms:performance.now()-start,...zero});
          } catch(error) {
            rows.push({query_id:query.id,collection_id:c.id,mode,repeat,status:'error',stage:'l0',
              error:error instanceof Error ? error.message:'unknown',elapsed_ms:performance.now()-start,...zero});
          }
        }
      }
      for(const [variant,question] of [['case_space','  '+query.question.toUpperCase().replaceAll(' ','   ')+'  '],['empty','']] as const) {
        for(const mode of ['baseline','candidate'] as const) {
          const start=performance.now();
          const r=await retrieveWithBudget({baseline:()=>search(question,5),expanded:()=>search(question,12),mode,policy});
          rows.push({query_id:query.id,collection_id:c.id,split:'test',mode,variant,repeat:0,status:'observed',
            entry_ids:r.hits.map(h=>h.id),injected_bytes:r.hits.reduce((n,h)=>n+Buffer.byteLength(h.content),0),
            injected_entries:r.hits.length,k:r.k,auxiliary_calls:r.auxiliaryCalls,fallback:r.fallback,
            fallback_reason:r.reason,signal_type:r.signalType,gap:r.gap,elapsed_ms:performance.now()-start,...zero});
        }
      }
    }
  } finally {store.close();}
  (indexRows.at(-1) as Record<string,unknown>).database_bytes=statSync(path).size;
}
} catch (error) {
  failure={status:'error',stage:'runner',error:error instanceof Error ? error.message:'unknown'};
  writeFileSync(join(out,'failure.json'),JSON.stringify({...failure,...zero},null,2)+'\n');
  process.exitCode=1;
}
writeFileSync(join(out,'rows.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
writeFileSync(join(out,'index.json'),JSON.stringify(indexRows,null,2)+'\n');
writeFileSync(join(out,'environment.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
  input_sha256:createHash('sha256').update(raw).digest('hex'),phase,sqlite:process.versions.sqlite,rows:rows.length,failure,...zero},null,2)+'\n');
console.log(JSON.stringify({phase,collections:indexRows.length,rows:rows.length,output:out,failure,...zero}));
