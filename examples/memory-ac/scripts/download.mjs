import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {dirname} from 'node:path';
import {hash} from '../src/adapters.mjs';
const kind=process.argv[2];let entries;
if(kind==='longmem')entries=[{path:'data/longmemeval_s_cleaned.json',url:'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json',sha256:'d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442'}];
else if(kind==='locomo')entries=[{path:'data/locomo10.json',url:'https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json',sha256:'553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365'}];
else if(kind==='beam'||kind==='reranker'){
 const manifest=JSON.parse(await readFile('evidence/'+kind+'-source.json','utf8'));
 entries=manifest.sources.map(s=>({...s,path:(kind==='beam'?'data/beam-v9/':'runtime/models/qwen3-reranker-06b-v9/')+s.path}));
}else throw Error('Usage: download.mjs longmem|locomo|beam|reranker; downloads only on explicit invocation');
for(const e of entries){let bytes;try{bytes=await readFile(e.path);}catch(err){if(err.code!=='ENOENT')throw err;
 const r=await fetch(e.url,{signal:AbortSignal.timeout(600000)});if(!r.ok)throw Error('download_http_'+r.status);bytes=Buffer.from(await r.arrayBuffer());
 if(hash(bytes)!==e.sha256)throw Error('download_hash_mismatch');await mkdir(dirname(e.path),{recursive:true});await writeFile(e.path,bytes,{flag:'wx'});}
 if(hash(bytes)!==e.sha256)throw Error('existing_hash_mismatch');console.log(JSON.stringify({status:'pass',path:e.path,sha256:e.sha256}));}
if(kind==='beam'||kind==='reranker'){
 const out=kind==='beam'?'data/beam-v9/manifest.json':'runtime/models/qwen3-reranker-06b-v9/manifest.json';
 try{await access(out);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(out,await readFile('evidence/'+kind+'-source.json'),{flag:'wx'});}
}
