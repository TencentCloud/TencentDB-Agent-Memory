import {readFile,writeFile} from 'node:fs/promises';
import {aggregate,compare,mean} from '../src/metrics.mjs';
import {hash} from '../src/adapters.mjs';
const [viewFile,labelFile,out]=process.argv.slice(2);
if(!out)throw Error('Usage: aggregate.mjs VIEWS_JSONL JUDGE_JSONL NEW_REPORT_JSON');
const rows=async f=>(await readFile(f,'utf8')).trim().split('\n').map(JSON.parse);
const views=await rows(viewFile),labels=new Map((await rows(labelFile)).map(x=>[x.probe_id+'|'+x.mode,x]));
const cs=views.map(v=>{const j=labels.get(v.probe_id+'|'+v.mode);if(!j||![0,1].includes(j.correct))throw Error('missing_or_invalid_label');return {...v,correct:j.correct};});
if(new Set(cs.map(c=>c.probe_id+'|'+c.mode)).size!==cs.length)throw Error('duplicate');
const splits={};for(const [split,rows]of Object.entries(Object.groupBy(cs,c=>c.split))){
 const modes=Object.groupBy(rows,c=>c.mode);if(!modes.native_k5)throw Error('native_baseline_required');
 splits[split]=Object.fromEntries(Object.entries(modes).map(([mode,xs])=>{const base=modes.native_k5;if(xs.length!==base.length||new Set([...xs,...base].map(c=>c.probe_id)).size!==base.length)throw Error('unpaired_denominator');
 return [mode,{...aggregate(xs),qa:mean(xs.map(x=>x.correct)),correct:xs.reduce((n,x)=>n+x.correct,0),
 qa_vs_native:compare(base.map(c=>({...c,complete:c.correct})),xs.map(c=>({...c,complete:c.correct})),10000)}];}));
}
await writeFile(out,JSON.stringify({status:'pass',metric_version:'ac-delivery-report-v1',splits,
 source_hashes:{views:hash(await readFile(viewFile)),labels:hash(await readFile(labelFile))},claim:'Public long-dialogue method validation only.'},null,2),{flag:'wx'});
