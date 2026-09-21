"""Apply the frozen source-only audit, without reading retrieval outputs or scores."""
import argparse
import hashlib
import json
from pathlib import Path

EXCLUSIONS = {
 'conv-41/Q069': '问题为 December 2023；引用会话时间为 22 December 2022，原文说 yesterday。时间前提错配。',
 'conv-41/Q068': '问题为 December 2023；引用会话时间为 17 December 2022。时间前提错配。',
 'conv-43/Q084': '问题称 Tim enjoy writing about；引用仅表明 hooked / chat about，未支持写作行为。',
 'conv-42/Q119': '问题主体为 Nate；引用 write a whole movie 的实际说话者为 Joanna。',
 'conv-50/Q147': '问题主体为 Calvin；引用称 writing lyrics boosts my motivation 的实际说话者为 Dave。',
 'conv-50/Q151': '问题主体为 Calvin；引用 taken up photography 的实际说话者为 Dave。',
}


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True,type=Path)
 p.add_argument('--output',required=True,type=Path);a=p.parse_args()
 inputs=json.loads((a.input/'inputs.json').read_bytes());labels=json.loads((a.input/'labels.json').read_bytes())
 manifest=json.loads((a.input/'manifest.json').read_bytes());audit=[]
 if not set(EXCLUSIONS)<=set(labels):raise ValueError('audit revision mismatch')
 for c in inputs:
  memories={m['id']:m for m in c['memories']}
  for q in c['queries']:
   label=labels[q['id']];e=label['evidence_ids'][0]
   audit.append({'query_id':q['id'],'question_sha256':hashlib.sha256(q['question'].encode()).hexdigest(),
      'source_id':e,'source_sha256':memories[e]['content_sha256'],
      'disposition':'exclude' if q['id'] in EXCLUSIONS else 'screened_no_identified_mismatch',
      'reason':EXCLUSIONS.get(q['id']),'reviewer':'single_execution_assistant_not_independent_human_annotation'})
  c['queries']=[q for q in c['queries'] if q['id'] not in EXCLUSIONS]
  manifest['splits'][c['id']]['selected_qa']=len(c['queries'])
  manifest['splits'][c['id']]['query_ids']=[q['id'] for q in c['queries']]
 for qid in EXCLUSIONS:del labels[qid]
 manifest.update(protocol_revision='E3-M17-R2-source-audit',selected_count=len(labels),
                 semantic_exclusion_count=6,resampled_after_audit=False,
                 audit_timing='R1 retrieval and training aggregate existed; R1 test scores not inspected; R1 excluded from final claims')
 a.output.mkdir(parents=True,exist_ok=False)
 for name,obj in [('inputs.json',inputs),('labels.json',labels),('manifest.json',manifest),('label_audit.json',audit)]:
  (a.output/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print(json.dumps({'selected':len(labels),'by_split':{s:sum(v['split']==s for v in labels.values()) for s in ['train','dev','test']}}))


if __name__=='__main__':main()
