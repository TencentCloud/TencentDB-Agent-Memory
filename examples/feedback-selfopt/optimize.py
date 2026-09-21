"""Explicit, zero-network SDK/SQLite integration fixture, not model evidence.

The replay classifier deliberately misses one update with empty rules. Its
scripted patch removes that injected fault. Only actual SQLite snapshots,
commits and locally consumed request bytes are measured. This small exact-text
annotation contract is specific to the public fixture, not a general evaluator.
"""
import sys
sys.dont_write_bytecode = True

import argparse
import hashlib
import json
from pathlib import Path

import demo
from fixture import ReplayClassifier, TURNS

INTERFACE = 'sqlite-six-turn-fixture-v1'
AUTHORITY = 'public-fixture-author'
RISKS = ('wrong_add', 'wrong_change', 'target_mismatch',
         'unauthorized_persistence', 'stale_active')
RULE = 'Apply explicit lasting replacements to the uniquely referred existing memory.'


def sha(value):
    return hashlib.sha256(demo.encoded(value)).hexdigest()


class FaultReplayClassifier(ReplayClassifier):
    """An injected engineering fault, never a model response or learned skill."""
    def __call__(self, **kwargs):
        result = super().__call__(**kwargs)
        if self.calls == 3 and not self.rules:
            proposal = json.loads(result['answer'])
            proposal.update(semantic_action='noop', object='answer', scope='current_turn',
                            durable=False, semantic_target_alias=None, replacement_segments=None)
            result['answer'] = json.dumps(proposal)
        return result


def read_rows(path):
    raw = Path(path).read_bytes()
    if len(raw) > demo.MAX_FILE_BYTES:
        raise demo.ExampleRejected('feedback_fixture_file_capacity')
    return [json.loads(line) for line in raw.splitlines()]


def project_feedback(directory, policy):
    """Bind complete local fixture observations; never accept arbitrary traces."""
    from tencentdb_agent_memory.feedback import FEEDBACK_SCHEMA

    rows = read_rows(Path(directory) / 'rows.private.jsonl')
    deliveries = read_rows(Path(directory) / 'deliveries.private.jsonl')
    if len(rows) != 6 or len(deliveries) != 6:
        raise demo.ExampleRejected('feedback_fixture_incomplete')
    projected = []
    previous = None
    error_root = None
    for index, (wrapped, delivery, turn) in enumerate(zip(rows, deliveries, TURNS), 1):
        host = wrapped['host']
        evidence = host['observation']['private_evidence']
        source_hash = hashlib.sha256(turn.user.encode('utf-8')).hexdigest()
        if (wrapped['context'] != 'engineering_fixture' or wrapped['actual_provider_delivery'] is not False
                or host['status'] != 'pass' or host['user'] != turn.user
                or evidence['binding_table']['source_sha256'] != source_hash
                or evidence['policy_rules'] != [r[1] for r in policy.rules]
                or delivery['acknowledged'] is not True
                or delivery['consumed_request_sha256'] != hashlib.sha256(
                    delivery['consumed_request_utf8'].encode('utf-8')).hexdigest()
                or host['wire']['request_hash'] != delivery['consumed_request_sha256']
                or host['wire']['delivered'] is not True
                or host['answer'] != delivery['answer']):
            raise demo.ExampleRejected('feedback_fixture_binding')
        before, after = host['before_state'], host['after_state']
        if (previous is not None and before != previous
                or previous is None and before['totalHeads'] != 0):
            raise demo.ExampleRejected('feedback_fixture_continuity')
        previous = after
        active = [r for r in after['entries'] if r['state'] == 'active']
        actual = [r['content'] for r in active]
        # Only the two publicly annotated, complete user statements have meanings.
        if any(s not in (TURNS[0].user, TURNS[2].user) for s in actual):
            raise demo.ExampleRejected('feedback_fixture_unannotated_content')
        expected = [TURNS[0 if index < 3 else 2].user] if index < 5 else []
        state = actual == expected and all(r['memory_scope'] == 'project_memory' for r in active)
        decision = host['decision']
        applied = bool(decision and decision.get('status') == 'applied')
        physical_action = decision['action'] if applied else 'noop'
        if turn.action == 'noop':
            commit = not applied and before == after
        else:
            commit = (applied and physical_action == turn.action and state
                      and after['revisionCount'] == before['revisionCount'] + 1)
            if commit and turn.action != 'add':
                commit = (len(before['entries']) == 1 and
                          decision['memoryId'] == before['entries'][0]['memoryId'])
        predicted = evidence['decoded_segmented_proposal']
        current = (not state and not commit and predicted['semantic_action'] != turn.action)
        if current:
            error_root = 'D1-U' + str(index)
        origin = 'current' if current else 'propagated' if not state and error_root else 'none'
        received = json.loads(host['answer'])['received_memories']
        if turn.probe and host['answer_history']:
            raise demo.ExampleRejected('feedback_fixture_probe_history')
        annotation = dict(user=turn.user, action=turn.action, contents=expected,
                          scope='project_memory', probe=turn.probe)
        risks = {k: False for k in RISKS}
        risks.update(wrong_add=applied and physical_action == 'add' and not state,
                     wrong_change=applied and physical_action != 'add' and not commit,
                     unauthorized_persistence=turn.action == 'noop' and applied,
                     stale_active=bool(actual) and actual != expected)
        projected.append(dict(
            dialogue='D1', lineage='public-sqlite-fixture', turn=index, repeat=1,
            root=error_root if origin != 'none' else 'D1-U' + str(index), origin=origin,
            authority=AUTHORITY, authority_kind='controlled_author',
            annotation_sha256=sha(annotation), source_sha256=source_hash,
            trace_sha256=sha(dict(row=wrapped, delivery=delivery)), text=turn.user,
            expected=annotation, predicted=predicted, observed=True,
            cause='policy_semantic' if current else 'none' if state else 'execution',
            family='durable_change_missed' if current else None,
            action=turn.action, probe=turn.probe,
            checks=dict(state=state, commit=bool(commit), use=received == expected if turn.probe else None),
            risks=risks, cost=dict(tokens=0, latency_ms=host['latency_ms']),
        ))
    return dict(schema=FEEDBACK_SCHEMA, interface_id=INTERFACE, split='train',
                policy_sha256=policy.sha256,
                planned=[['D1', i, 1] for i in range(1, 7)], rows=projected)


def run(*, fixture=False, core=None, node='node', output=None):
    if not fixture:
        return dict(mode='off', model_calls=0, http_requests=0)
    from tencentdb_agent_memory.feedback import FeedbackOptimizer, PolicySnapshot

    directory = demo._new_output(output)
    directory.mkdir(exist_ok=False)
    optimizer = FeedbackOptimizer(interface_id=INTERFACE, allowed_sources=(AUTHORITY,),
                                  excluded_literals=('SampleBoard', 'Alder', 'Birch'), enabled=True)
    try:
        baseline = demo.run_example(fixture=True, core=core, node=node, output=directory / 'baseline',
                                    classifier_factory=FaultReplayClassifier)
        if baseline['status'] != 'pass':
            raise demo.ExampleRejected('feedback_fixture_baseline_failed')
        before = project_feedback(directory / 'baseline', optimizer.active)
        prepared = optimizer.prepare(before)
        if not prepared['eligible']:
            raise demo.ExampleRejected('feedback_fixture_not_eligible')
        from shared.segmented_trajectory_intent import SYSTEM
        optimizer.generation_request(SYSTEM)  # Build only; no provider call.
        proposal = dict(family=prepared['packet']['selected_family'],
                        support=[[r[k] for k in ('dialogue', 'turn', 'repeat', 'root')]
                                 for r in prepared['packet']['errors']],
                        patch=dict(op='add', rule_id='R1', text=RULE))
        candidate = optimizer.submit_response(prepared['packet_sha256'], json.dumps(proposal))
        assert optimizer.active == PolicySnapshot()
        artifact = dict(schema_version=1, artifact_kind='static_memory_rules',
                        generation=candidate.version,
                        rules=[dict(rule_id=i, text=t) for i, t in candidate.rules])
        policy_path = directory / 'candidate-policy.json'
        with policy_path.open('xb') as stream:
            stream.write(demo.encoded(artifact))
        following = demo.run_example(fixture=True, core=core, node=node, output=directory / 'candidate',
                                     policy=policy_path, classifier_factory=FaultReplayClassifier)
        if following['status'] != 'pass':
            raise demo.ExampleRejected('feedback_fixture_candidate_failed')
        after = project_feedback(directory / 'candidate', candidate)
        decision = optimizer.evaluate(after)
        # Actual local timing is not deterministic; it may reject adoption.
        if decision['adopt']:
            optimizer.rollback('operator_request')
        summary = dict(context='engineering_fixture', scripted_fault_and_proposal=True,
                       actual_provider_delivery=False, model_calls=0, http_requests=0,
                       completed_turns=12, before_correct=sum(r['checks']['state'] for r in before['rows']),
                       after_correct=sum(r['checks']['state'] for r in after['rows']),
                       comparison=decision, final_policy_version=optimizer.active.version,
                       optimization_usefulness_established=False)
        demo.EvidenceWriter(directory).write('summary.json', summary)
        return summary
    finally:
        optimizer.disable()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', action='store_true')
    parser.add_argument('--core', default='MemoryCore')
    parser.add_argument('--node', default='node')
    parser.add_argument('--output')
    args = parser.parse_args()
    if not args.fixture:
        return 0
    try:
        print(json.dumps(run(**vars(args))))
        return 0
    except Exception as exc:
        print(json.dumps(dict(status='error', code=demo.error_code(exc), model_calls=0)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
