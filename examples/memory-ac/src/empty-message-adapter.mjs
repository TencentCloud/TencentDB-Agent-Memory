// Input-only normalization for APIs that reject empty content. Never drop gold.
export function withoutEmptyMessages(subjects){
 const skipped=[];
 const normalized=subjects.map(s=>({...s,messages:s.messages.filter(m=>{
  if(m.content!=='')return true;
  if(m.gold||s.probes.some(p=>p.gold_ids.includes(m.id)))throw Error('empty_gold_not_evaluable');
  skipped.push({subject_id:s.subject_id,turn_id:m.id,role:m.role,reason:'exact_empty_non_gold'});return false;
 })}));
 return {subjects:normalized,skipped};
}
