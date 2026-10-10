"""Deterministic LoCoMo adapter. Only standard library; no model or service."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

REVISION = '3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376'
DATA_HASH = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4'
SEED = 20260914


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def normalized(text):
    return ' '.join(re.findall(r'\w+', str(text).lower()))


def adapt(data):
    ordered = sorted(data, key=lambda x: digest(f'{SEED}|{x["sample_id"]}'))
    inputs, labels, rejected = [], {}, []
    manifest = {'protocol_revision': 'E3-M17-R1-before-scoring', 'seed': SEED, 'source_revision': REVISION, 'source_sha256': DATA_HASH,
                'source_qa_count': sum(len(x['qa']) for x in data), 'splits': {},
                'alignment': 'one source dia_id -> one verbatim L1 entry; all evidence IDs retained'}
    speakers = {}
    content_sets = {}
    for ci, item in enumerate(ordered):
        cid = item['sample_id']
        split = 'train' if ci < 4 else ('dev' if ci < 6 else 'test')
        memories = []
        conv = item['conversation']
        session_keys = sorted((k for k in conv if re.fullmatch(r'session_\d+', k)),
                              key=lambda k: int(k.split('_')[1]))
        for key in session_keys:
            for turn in conv[key]:
                content = f'{turn["speaker"]}: {turn["text"]}'
                memories.append({'id': f'{cid}/{turn["dia_id"]}', 'source_id': turn['dia_id'],
                    'speaker': turn['speaker'], 'session_id': key,
                    'timestamp_original': conv.get(key + '_date_time'), 'content': content,
                    'content_sha256': digest(content), 'image_present': bool(turn.get('img_url'))})
        ids = [m['source_id'] for m in memories]
        by_id = {m['source_id']: m for m in memories}
        counts = Counter(ids)
        if len(memories) > 1024 or any(len(m['content'].encode('utf-8')) > 8192 for m in memories):
            raise ValueError('source_capacity: no silent truncation')
        if sum(len(m['content'].encode('utf-8')) for m in memories) > 4*1024*1024:
            raise ValueError('source_capacity')
        eligible = []
        for qi, qa in enumerate(item['qa']):
            qid = f'{cid}/Q{qi:03d}'
            evidence = qa.get('evidence', [])
            reason = None
            if qa['category'] not in [1, 2, 4]:
                reason = 'outside_category_1_2_4'
            elif not isinstance(evidence, list) or not evidence:
                reason = 'empty_evidence'
            elif any(not isinstance(e, str) or counts.get(e, 0) != 1 for e in evidence):
                reason = 'unresolved_or_ambiguous_evidence'
            elif len(set(evidence)) != len(evidence):
                reason = 'duplicate_evidence'
            elif qa['category'] != 4 or len(evidence) != 1:
                reason = 'outside_single_source_fact_scope'
            elif by_id[evidence[0]]['image_present']:
                reason = 'image_bearing_evidence_excluded'
            elif len(normalized(qa.get('answer', ''))) < 3:
                reason = 'answer_too_short_to_ground'
            elif (' '+normalized(qa.get('answer', ''))+' ') not in (' '+normalized(by_id[evidence[0]]['content'])+' '):
                reason = 'answer_not_literal_in_cited_text'
            elif (' '+normalized(qa.get('answer', ''))+' ') in (' '+normalized(qa['question'])+' '):
                reason = 'answer_already_in_question'
            if reason:
                rejected.append({'query_id': qid, 'reason': reason, 'original_evidence': evidence})
            else:
                eligible.append((qi, qa))
        selected = sorted(eligible, key=lambda t: digest(f'{SEED}|{cid}|{t[0]}'))[:12]
        queries = []
        for qi, qa in selected:
            qid = f'{cid}/Q{qi:03d}'
            queries.append({'id': qid, 'question': qa['question']})
            labels[qid] = {'collection_id': cid, 'split': split, 'category': qa['category'],
                          'original_qa_index': qi, 'reference_answer': qa.get('answer'),
                          'evidence_ids': [f'{cid}/{e}' for e in qa['evidence']],
                          'label_status': 'literal_grounded_public_source_reference_not_independent_annotation'}
        inputs.append({'id': cid, 'split': split, 'memories': memories, 'queries': queries})
        manifest['splits'][cid] = {'split': split, 'turns': len(memories), 'sessions': len(session_keys),
                                 'eligible_qa': len(eligible), 'selected_qa': len(queries),
                                 'query_ids': [q['id'] for q in queries]}
        speakers[cid] = set(m['speaker'] for m in memories)
        content_sets[cid] = set(digest(m['content']) for m in memories)
    manifest['cross_split_checks'] = []
    for i, left in enumerate(inputs):
        for right in inputs[i+1:]:
            if left['split'] != right['split']:
                manifest['cross_split_checks'].append({'left': left['id'], 'right': right['id'],
                    'shared_speaker_names': sorted(speakers[left['id']] & speakers[right['id']]),
                    'exact_shared_content_count': len(content_sets[left['id']] & content_sets[right['id']])})
    manifest['exclusions_by_reason'] = dict(Counter(x['reason'] for x in rejected))
    manifest['unused_eligible_count'] = sum(x['eligible_qa']-x['selected_qa'] for x in manifest['splits'].values())
    manifest['selected_count'] = len(labels)
    return inputs, labels, manifest, rejected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DATA_HASH:
        raise ValueError('dataset hash mismatch: never substitute another revision')
    parts = adapt(json.loads(raw))
    args.output.mkdir(parents=True, exist_ok=False)
    for filename, obj in zip(['inputs.json', 'labels.json', 'manifest.json', 'exclusions.json'], parts):
        (args.output/filename).write_text(json.dumps(obj, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(parts[2], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
