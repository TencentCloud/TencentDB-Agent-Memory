"""Read-only aggregation of frozen scored retrieval rows; standard library only."""
import argparse
from collections import Counter,defaultdict
import hashlib
import itertools
import json
import math
from pathlib import Path
import statistics


def percentile(values,p):
    x=sorted(values)
    if not x:return None
    k=(len(x)-1)*p;lo=math.floor(k);hi=math.ceil(k)
    return x[lo]+(x[hi]-x[lo])*(k-lo)


def score(row,label):
    r=dict(row)
    r['gold_evidence_ids']=label['evidence_ids']
    if row['status']=='error':
        r.update(recall=None,all_hit=None,precision=None)
        return r
    gold=set(label['evidence_ids']);found=gold & set(row['entry_ids'])
    r.update(recall=len(found)/len(gold),all_hit=len(found)==len(gold),any_hit=bool(found),
             precision=len(found)/len(row['entry_ids']) if row['entry_ids'] else 0,
             missing_evidence_ids=sorted(gold-found),status='pass' if found==gold else 'fail')
    return r


def aggregate(rows):
    valid=[x for x in rows if x['status']!='error']
    return {'n':len(rows),'errors':len(rows)-len(valid),
        **{k:statistics.mean(x[k] for x in valid) if valid else None
           for k in ['recall','all_hit','precision','injected_bytes','injected_entries']},
        'correct':sum(x['all_hit'] for x in valid),'fallbacks':sum(x['fallback'] for x in valid)}


def summarize(rows,labels):
    scored=[score(x,labels[x['query_id']]) for x in rows]
    primary=[x for x in scored if x.get('repeat')==0 and 'variant' not in x]
    modes=sorted(set(x['mode'] for x in primary)); by_mode={m:aggregate([x for x in primary if x['mode']==m]) for m in modes}
    baseline={x['query_id']:x for x in primary if x['mode']=='baseline'}
    candidate={x['query_id']:x for x in primary if x['mode']=='candidate'}
    pairs=[]
    for qid,a in baseline.items():
        b=candidate[qid]
        pairs.append({'query_id':qid,'collection_id':a['collection_id'],
            'baseline_recall':a['recall'],'candidate_recall':b['recall'],
            'delta':None if a['recall'] is None or b['recall'] is None else b['recall']-a['recall'],
            'gold_evidence_ids':a['gold_evidence_ids'],'baseline_entry_ids':a.get('entry_ids'),
            'candidate_entry_ids':b.get('entry_ids')})
    clusters=defaultdict(list)
    for p in pairs:
        if p['delta'] is not None:clusters[p['collection_id']].append(p['delta'])
    deltas={k:statistics.mean(v) for k,v in clusters.items()}
    vals=list(deltas.values());observed=abs(statistics.mean(vals))
    permutations=[abs(statistics.mean(s*v for s,v in zip(signs,vals))) for signs in itertools.product([-1,1],repeat=len(vals))]
    boot=[statistics.mean(sample) for sample in itertools.product(vals,repeat=len(vals))]
    latency={}
    repeat_consistency={}
    for mode in modes:
        r=[x for x in scored if x['mode']==mode and 'variant' not in x]
        latency[mode]={'n':len(r),'p50_ms':percentile([x['elapsed_ms'] for x in r],.5),
          'p95_ms':percentile([x['elapsed_ms'] for x in r],.95),
          'mean_ms':statistics.mean(x['elapsed_ms'] for x in r),
          'auxiliary_calls':sum(x.get('auxiliary_calls',0) for x in r)}
        grouped=defaultdict(set)
        for x in r:grouped[x['query_id']].add(tuple(x.get('entry_ids',[])))
        repeat_consistency[mode]=all(len(v)==1 for v in grouped.values())
    robustness={}
    for variant in ['case_space','empty']:
        robustness[variant]={m:aggregate([x for x in scored if x.get('variant')==variant and x['mode']==m])
                            for m in ['baseline','candidate']}
    forced=[x for x in primary if x['mode']=='forced_error']
    off_equal=all(x.get('entry_ids')==baseline[x['query_id']].get('entry_ids') for x in forced)
    return scored,{'experiment':'E3-M17','primary':by_mode,'candidate_vs_baseline':{
        'known_pairs':sum(p['delta'] is not None for p in pairs),
        'improved':sum(p['delta'] is not None and p['delta']>0 for p in pairs),
        'regressed':sum(p['delta'] is not None and p['delta']<0 for p in pairs),
        'same':sum(p['delta']==0 for p in pairs),
        'cluster_deltas':deltas,'cluster_n':len(vals),
        'cluster_signflip_two_sided_p':sum(x>=observed-1e-12 for x in permutations)/len(permutations),
        'cluster_bootstrap_percentile_95_exploratory':[percentile(boot,.025),percentile(boot,.975)],
        'cluster_sample_sd':statistics.stdev(vals)},
        'latency':latency,'repeated_results_identical':repeat_consistency,'robustness':robustness,
        'forced_error_matches_baseline':off_equal,'pairs':pairs,'model_calls':0,'http_requests':0,'token_usage':None}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rows',required=True,type=Path);p.add_argument('--labels',required=True,type=Path)
    p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    raw=a.rows.read_bytes();labels_raw=a.labels.read_bytes()
    scored,summary=summarize([json.loads(l) for l in raw.splitlines()],json.loads(labels_raw))
    summary['input_sha256']={'rows':hashlib.sha256(raw).hexdigest(),'labels':hashlib.sha256(labels_raw).hexdigest()}
    a.output.mkdir(parents=True,exist_ok=False)
    (a.output/'scored_rows.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in scored),encoding='utf-8')
    (a.output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='pairs'},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
