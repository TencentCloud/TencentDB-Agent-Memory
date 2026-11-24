export const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export function quantile(xs,p){if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b);return a[Math.floor((a.length-1)*p)];}
export function evidenceMetrics(gold,selected,turnMap,excluded=false){
  if(excluded || !gold.length)return {recall:null,complete:null,hit:null,precision:null};
  const have=new Set(selected.map(x=>x.id));
  const covered=gold.filter(id=>{const chunks=turnMap[id];return chunks?.length && chunks.every(c=>have.has(c));});
  const relevant=new Set(gold.flatMap(id=>turnMap[id] ?? []));
  return {recall:covered.length/gold.length,complete:Number(covered.length===gold.length),
    hit:Number(covered.length>0),precision:selected.length?selected.filter(x=>relevant.has(x.id)).length/selected.length:0};
}
export function aggregate(rows){
  const eligible=rows.filter(x=>x.complete!==null);
  return {n:rows.length,eligible:eligible.length,excluded:rows.length-eligible.length,
    evidence_complete:mean(eligible.map(x=>x.complete)),evidence_recall:mean(eligible.map(x=>x.recall)),
    evidence_hit:mean(eligible.map(x=>x.hit)),mean_tokens:mean(rows.map(x=>x.tokens)),
    mean_injected:mean(rows.map(x=>x.injected_count)),retrieval_p50_ms:quantile(rows.map(x=>x.latency_ms).filter(Number.isFinite),.5),
    retrieval_p95_ms:quantile(rows.map(x=>x.latency_ms).filter(Number.isFinite),.95)};
}
function rng(seed=20260824){return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
// Paired cluster bootstrap; shared conversation/group is the resampling unit.
export function compare(base,adapt,repetitions=10000){
  const byId=new Map(base.map(x=>[x.probe_id,x]));
  const pairs=adapt.map(a=>({a,b:byId.get(a.probe_id)})).filter(x=>x.b);
  const grouped=Object.groupBy(pairs,x=>x.a.group_id);const groups=Object.values(grouped);const random=rng();
  const delta=[],token=[];
  for(let i=0;i<repetitions;i++){
    let n=0,d=0,ta=0,tb=0;
    for(let j=0;j<groups.length;j++)for(const {a,b} of groups[Math.floor(random()*groups.length)]){
      if(a.complete!==null&&b.complete!==null){n++;d+=a.complete-b.complete;}ta+=a.tokens;tb+=b.tokens;
    }
    if(n)delta.push(d/n);if(tb)token.push(1-ta/tb);
  }
  const eligible=pairs.filter(x=>x.a.complete!==null&&x.b.complete!==null);
  const deltaValue=mean(eligible.map(x=>x.a.complete-x.b.complete));
  return {paired_n:pairs.length,eligible_n:eligible.length,clusters:groups.length,
    complete_delta:deltaValue,complete_delta_ci95:[quantile(delta,.025),quantile(delta,.975)],
    token_reduction:1-mean(pairs.map(x=>x.a.tokens))/mean(pairs.map(x=>x.b.tokens)),
    token_reduction_ci95:[quantile(token,.025),quantile(token,.975)],
    quality_wins:eligible.filter(x=>x.a.complete>x.b.complete).length,quality_losses:eligible.filter(x=>x.a.complete<x.b.complete).length,
    caveat:'Pilot percentile bootstrap; few clusters/zero discordant pairs do not certify tight non-inferiority.'};
}
