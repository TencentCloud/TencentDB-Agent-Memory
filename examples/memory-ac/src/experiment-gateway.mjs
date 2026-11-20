import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {GatewayClient} from './client.mjs';
import {hash,chunks} from './adapters.mjs';
import {evidenceMetrics} from './metrics.mjs';
import {formatConversationSearchResponse} from '../vendor/TencentDB-Agent-Memory/MemoryCore/src/core/tools/conversation-search.ts';
import {getEncoding} from '../vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/js-tiktoken/dist/index.js';
export const encoding=getEncoding('cl100k_base');
export class ExperimentGateway {
 constructor(directory){this.directory=resolve(directory);this.client=new GatewayClient({baseUrl:'http://127.0.0.1:18421'});this.maps=new Map();}
 async start(shard,config='config/gateway.l0.yaml'){
  try{await fetch('http://127.0.0.1:18421/health',{signal:AbortSignal.timeout(500)});throw Error('occupied');}catch(e){if(e.message==='occupied')throw e;}
  this.dbDir=join(this.directory,`shard-${shard}`,'db');await mkdir(this.dbDir,{recursive:true});
  this.fd=openSync(join(this.directory,`shard-${shard}`,`gateway-${Date.now()}.log`),'a');
  this.server=spawn(process.execPath,['--import',pathToFileURL(resolve('vendor/TencentDB-Agent-Memory/MemoryCore/node_modules/tsx/dist/loader.mjs')).href,resolve('vendor/TencentDB-Agent-Memory/MemoryCore/src/gateway/server.ts')],{windowsHide:true,stdio:['ignore',this.fd,this.fd],env:{...process.env,TDAI_GATEWAY_CONFIG:resolve(config),TDAI_DATA_DIR:this.dbDir,TDAI_GATEWAY_PORT:'18421',TDAI_GATEWAY_API_KEY:'local-lab-only'}});
  for(let i=0;i<90;i++){if(this.server.exitCode!==null)throw Error(`Gateway exited ${this.server.exitCode}`);try{const r=await fetch('http://127.0.0.1:18421/health',{signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('start timeout');
 }
 async stop(){if(this.server&&this.server.exitCode===null&&this.server.signalCode===null)await new Promise(r=>{this.server.once('exit',r);this.server.kill();});this.server=undefined;if(this.fd!==undefined)closeSync(this.fd);this.fd=undefined;}
 async ingest(s){const map={subject_id:s.subject_id,turns:{},accepted:{},scope:{team_id:'ac-lab',agent_id:'ac-eval',user_id:`${hash(this.directory).slice(0,12)}:${s.subject_id}`}};
  for(const [sid,messages]of Object.entries(Object.groupBy(s.messages,m=>m.session_id))){const session_id=`r2:${hash(s.subject_id).slice(0,10)}:${sid}`,parts=messages.flatMap(m=>chunks(m.content).map((content,index)=>({m,content,index})));
   for(let i=0;i<parts.length;i+=25){const batch=parts.slice(i,i+25),r=await this.client.post('/conversation/add',{...map.scope,session_id,messages:batch.map(x=>({role:x.m.role,content:x.content}))});assert.equal(r.data.accepted_ids.length,batch.length);
    r.data.accepted_ids.forEach((id,j)=>{const p=batch[j];(map.turns[p.m.id]??=[]).push(id);map.accepted[id]={turn_id:p.m.id,session_id,chunk_index:p.index,content_hash:hash(p.content),source_date:p.m.date};});
   }
  }
  const check=await this.client.post('/conversation/query',{...map.scope,limit:100,offset:0});assert.equal(check.data.total,Object.keys(map.accepted).length);
  for(const item of check.data.messages)assert.equal(hash(item.content),map.accepted[item.id].content_hash);
  for(const m of s.messages)assert.equal(map.turns[m.id].length,chunks(m.content).length);
  this.maps.set(s.subject_id,map);await appendFile(join(this.directory,'id-maps.jsonl'),JSON.stringify(map)+'\n');return map;
 }
 render(s,items,strategy='fts'){const map=this.maps.get(s.subject_id);for(const item of items)assert(map.accepted[item.id],`unknown scope ${item.id}`);
  return formatConversationSearchResponse({strategy,total:items.length,results:items.map(i=>({...i,session_key:map.accepted[i.id].session_id,recorded_at:i.timestamp}))});}
 metric(s,p,items,mode,k,latency=null,strategy='fts'){const map=this.maps.get(s.subject_id),context=this.render(s,items,strategy);return {probe_id:p.id,dataset:s.dataset,group_id:s.group_id,split:s.split,category:p.category,mode,k,exclusion:p.exclusion,...evidenceMetrics(p.gold_ids,items,map.turns,!!p.exclusion),tokens:encoding.encode(context,'all').length,injected_count:items.length,latency_ms:latency,selected_ids:items.map(i=>i.id),context_sha256:hash(context)};}
}
