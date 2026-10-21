import {readFile,writeFile} from 'node:fs/promises';
import {fitSlate} from '../src/v11-slate.mjs';
const [pairsPath,headsPath,out]=process.argv.slice(2);
if(!out)throw Error('Usage: fit.mjs PAIRS_JSONL HEADS_OR_MODEL_BUNDLE NEW_MODEL_JSON');
const pairs=(await readFile(pairsPath,'utf8')).trim().split('\n').map(JSON.parse),head=JSON.parse(await readFile(headsPath,'utf8'));
const models=Object.fromEntries(['qa','active','uniform','sham'].map(x=>['slate_'+x,fitSlate(pairs,x)]));
await writeFile(out,JSON.stringify({version:'v11-model-bundle',heads:head.heads??head,models},null,2),{flag:'wx'});
console.log(JSON.stringify({status:'pass',pairs:pairs.length,models:4,auto_deploy:false}));
