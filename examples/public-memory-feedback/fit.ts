/** One bounded training update, followed by a disjoint development adoption gate. */
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BUDGET_THRESHOLDS,selectBudget,type BudgetHit } from '../../MemoryCore/src/core/feedback/retrieval-budget.js';
interface Row {query_id:string;split:string;baseline:BudgetHit[];expanded:BudgetHit[]}
interface Label {split:string;evidence_ids:string[]}
export function metrics(rows:Row[], labels:Record<string,Label>,threshold:number|null) {
  if(!rows.length) throw Error('empty_split');
  let recall=0,all=0,bytes=0,count=0;
  for(const row of rows) {
    const label=labels[row.query_id];
    if(!label||label.split!==row.split||!label.evidence_ids.length) throw Error('label_alignment');
    const hits=threshold===null?row.baseline:selectBudget(row.baseline,row.expanded,
      {schemaVersion:1,approved:false,threshold}).hits;
    const found=label.evidence_ids.filter(id=>hits.some(h=>h.id===id)).length;
    recall+=found/label.evidence_ids.length;all+=Number(found===label.evidence_ids.length);
    bytes+=hits.reduce((n,h)=>n+Buffer.byteLength(h.content),0);count+=hits.length;
  }
  return {n:rows.length,recall:recall/rows.length,all_hit:all/rows.length,
    mean_bytes:bytes/rows.length,mean_entries:count/rows.length,utility:(recall-0.01*count)/rows.length};
}
export function fit(rows:Row[],labels:Record<string,Label>) {
  const train=rows.filter(r=>r.split==='train'); const dev=rows.filter(r=>r.split==='dev');
  const choices=BUDGET_THRESHOLDS.map(threshold=>({threshold,...metrics(train,labels,threshold)}));
  choices.sort((a,b)=>b.utility-a.utility||a.mean_bytes-b.mean_bytes||a.threshold-b.threshold);
  const threshold=choices[0]!.threshold;
  const before=metrics(dev,labels,null), after=metrics(dev,labels,threshold);
  const gates={recall_gain_5pp:after.recall-before.recall>=0.05-1e-12,
    no_all_hit_regression:after.all_hit>=before.all_hit-1e-12,
    injection_bytes_at_most_2x:after.mean_bytes<=2*before.mean_bytes};
  return {experiment:'E3-M17',protocol_revision:'E3-M17-R2-source-audit',
    policy:{schemaVersion:1 as const,threshold,approved:Object.values(gates).every(Boolean)},
    selection:'maximize train recall minus 0.01 times injected entries; tie: bytes then threshold',
    train_baseline:metrics(train,labels,null),train_choices:choices,dev:{baseline:before,candidate:after,gates},
    test_labels_used_for_fit:0,candidate_count:5,new_candidates:1,model_calls:0};
}
const args=process.argv.slice(2);
if(args.length) {
  const [rowFile,labelFile,outFile]=args;
  if(!rowFile||!labelFile||!outFile||existsSync(outFile)) throw Error('usage: fit.ts ROWS LABELS NEW_POLICY');
  const bytes=readFileSync(rowFile);const rows=bytes.toString('utf8').trim().split('\n').map(x=>JSON.parse(x));
  const labelBytes=readFileSync(labelFile);const result=fit(rows,JSON.parse(labelBytes.toString('utf8')));
  writeFileSync(outFile,JSON.stringify({...result,source_rows_sha256:createHash('sha256').update(bytes).digest('hex'),
    labels_file_sha256:createHash('sha256').update(labelBytes).digest('hex')},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result,null,2));
}
