import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {longmem,locomo,hash,validate} from '../src/adapters.mjs';
import {withoutEmptyMessages} from '../src/empty-message-adapter.mjs';
const [adapter,source,out]=process.argv.slice(2);
if(!out)throw Error('Usage: prepare-public.mjs longmem|locomo|ADAPTER_MODULE SOURCE_JSON NEW_OUT_DIRECTORY');
const bytes=await readFile(source),raw=JSON.parse(bytes),selection=JSON.parse(await readFile('evidence/selection.json','utf8'));
let subjects;
if(adapter==='longmem'){
 if(hash(bytes)!=='d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442')throw Error('public_source_checksum');
 const selected=new Map(selection.filter(x=>x.cohort==='longmem').map(x=>[x.probe_id,x]));
 const originals=new Map(raw.map(r=>['longmem:'+r.question_id,r]));
 subjects=longmem(raw,raw.length).filter(s=>selected.has(s.subject_id)).map(s=>({...s,group_id:selected.get(s.subject_id).group_id,
  split:selected.get(s.subject_id).split,probes:s.probes.map(p=>({...p,question_date:originals.get(s.subject_id).question_date}))}));
 if(subjects.length!==168)throw Error('frozen_selection_incomplete');
}else if(adapter==='locomo'){
 if(hash(bytes)!=='553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365')throw Error('public_source_checksum');
 subjects=locomo(raw).map(s=>({...s,split:'calibration'}));
}else subjects=await(await import(pathToFileURL(resolve(adapter)).href)).adapt(raw);
const normalized=withoutEmptyMessages(subjects);subjects=normalized.subjects;
validate(subjects);if(subjects.some(s=>!['train','development','calibration'].includes(s.split)))throw Error('protected_or_unknown_split');
await mkdir(out);
await writeFile(out+'/subjects.jsonl',subjects.map(JSON.stringify).join('\n')+'\n',{flag:'wx'});
await writeFile(out+'/protocol.json',JSON.stringify({version:'ac-delivery-reingest-v1',adapter,source_sha256:hash(bytes),
 subjects:subjects.length,questions:subjects.reduce((n,s)=>n+s.probes.length,0),exact_empty_non_gold_skipped:normalized.skipped,
 historical_metric_reproduction:false,reason:'Fresh one-subject-per-shard ingestion; original LME used 13 shared shards. All baselines must be rerun.'},null,2),{flag:'wx'});
