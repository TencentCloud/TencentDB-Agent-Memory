import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fitResidual} from '../src/v10-residual.mjs';
import {hash} from '../src/adapters.mjs';
const bytes=await readFile('evidence/residual-training-pairs.jsonl');
const pairs=bytes.toString('utf8').trim().split('\n').map(JSON.parse);
const model=JSON.parse(await readFile('evidence/models.json','utf8'));
const selection=JSON.parse(await readFile('evidence/selection.json','utf8'));
const train=new Set(selection.filter(x=>x.cohort==='longmem'&&x.split==='train').map(x=>x.probe_id));
assert.equal(pairs.length,180);
assert.equal(pairs.filter(x=>x.source==='qa').length,171);
assert.equal(pairs.filter(x=>x.source==='intervention').length,9);
for(const p of pairs){
  assert(train.has(p.probe_id),'nontraining residual feedback');
  for(const key of ['query','answer','context'])assert(!(key in p),'raw content not packaged');
}
const fitted={};
for(const variant of ['qa','intervention','sham']){
  const name=variant+'_residual';
  fitted[name]=fitResidual(pairs,variant);
  assert.deepEqual(fitted[name],model.heads[name],name);
}
const out=process.argv[2];
if(out)await writeFile(out,JSON.stringify(fitted,null,2),{flag:'wx'});
console.log(JSON.stringify({status:'pass',training_questions_available:train.size,training_pairs:180,
 qa_pairs:171,intervention_pairs:9,refitted_residual_models:3,exact_parameter_equivalence:true,
 feedback_sha256:hash(bytes),labels_changed:false,new_model_calls:0,auto_deploy:false},null,2));
