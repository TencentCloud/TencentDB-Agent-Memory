"""Parquet normalization: retain official content and references; freeze before scoring."""
import ast
import hashlib
import json
from pathlib import Path
import pyarrow.parquet as pq

root = Path('data/beam-v9')
assert (root/'manifest.json').exists()
output = root/'export-v9.0'
assert not output.exists(), 'refuse overwrite'
output.mkdir()
metadata = []
for scale in ['100K','500K','1M']:
    for r in pq.read_table(root/'data'/f'{scale}-00000-of-00001.parquet',columns=['conversation_id','conversation_seed']).to_pylist():
        group = r['conversation_seed']['category']+'\0'+r['conversation_seed']['title']
        metadata.append(dict(scale=scale,id=r['conversation_id'],group_id=hashlib.sha256(group.encode()).hexdigest()[:24],category=r['conversation_seed']['category']))
assert len(metadata)==90 and len({r['group_id'] for r in metadata})==90
for scale in ['100K','500K','1M']:
    ordered=sorted([r for r in metadata if r['scale']==scale],key=lambda r:hashlib.sha256(('v9-beam-split:'+r['group_id']).encode()).hexdigest())
    # The one schema-inspected conversation is explicitly development, never final.
    if scale=='100K': ordered.sort(key=lambda r:r['id']!='1')
    ntrain=len(ordered)//2; ncal=(len(ordered)-ntrain)//2
    for i,r in enumerate(ordered): r['split']='train' if i<ntrain else 'calibration' if i<ntrain+ncal else 'protected_test'
(output/'split-manifest.json').write_text(json.dumps(dict(version='ac-beam-groups-v9.0',seed='v9-beam-split',schema_smoke='100K:1 assigned train before outcome evaluation',dataset_manifest_sha256=hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest(),subjects=metadata,protected_rule='No model scoring, training, QA or outcome inspection for protected_test until final code and policy lock'),indent=2),encoding='utf8')
lookup={(r['scale'],r['id']):r for r in metadata}
counts={}
for scale in ['100K','500K','1M']:
    rows=pq.read_table(root/'data'/f'{scale}-00000-of-00001.parquet').to_pylist()
    with (output/f'{scale}.jsonl').open('x',encoding='utf8') as f:
        for r in rows:
            text=r['probing_questions']; assert len(text)<1000000
            probes=ast.literal_eval(text)
            assert isinstance(probes,dict) and all(isinstance(v,list) for v in probes.values())
            row=dict(**lookup[(scale,r['conversation_id'])],chat=r['chat'],probing_questions=probes)
            f.write(json.dumps(row,ensure_ascii=False)+'\n')
            counts[row['split']]=counts.get(row['split'],0)+sum(len(v) for v in probes.values())
print(json.dumps(dict(status='pass',conversations=90,question_counts=counts,protected_outcomes_inspected=False)))
