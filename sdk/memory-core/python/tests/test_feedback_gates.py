"""Boundary and adoption checks through the public API, without provider calls."""
from copy import deepcopy
import json
import unittest

from test_feedback_api import optimizer, stage
from _feedback_fixture import feedback_fixture, scripted_proposal, synthetic_comparison
from tencentdb_agent_memory.feedback import FeedbackRejected, PolicySnapshot


class FeedbackGateTests(unittest.TestCase):
    def test_only_current_verified_policy_errors_start_exploration(self):
        for field, values in (
            ('cause', ('interface', 'execution', 'retrieval', 'answer', 'infrastructure', 'none')),
            ('origin', ('propagated', 'none')),
        ):
            for value in values:
                before = feedback_fixture()
                before['rows'][0][field] = value
                with self.subTest(field=field, value=value):
                    self.assertFalse(optimizer().prepare(before)['eligible'])
        before = feedback_fixture()
        before['rows'][-1]['cause'] = 'integrity'
        self.assertEqual(optimizer().prepare(before)['reason'], 'feedback_integrity_failure')
        before = feedback_fixture()
        for row in before['rows']:
            if row['action'] == 'noop':
                row['checks']['commit'] = False
        self.assertEqual(optimizer().prepare(before)['reason'], 'write_and_noop_controls_required')

    def test_source_plan_and_authority_are_bound(self):
        for mutate in (
            lambda b: b['rows'][0].update(source_sha256='0' * 64),
            lambda b: b['rows'][0].update(authority_kind='model_judge'),
            lambda b: b.update(split='frozen_test'),
            lambda b: b['rows'].pop(),
            lambda b: b['planned'][0].__setitem__(1, True),
            lambda b: b['rows'][0]['checks'].update(state=1),
            lambda b: b.update(interface_id='other-interface'),
        ):
            before = feedback_fixture()
            mutate(before)
            with self.assertRaises(FeedbackRejected):
                optimizer().prepare(before)

    def test_correct_behavior_risks_and_costs_are_independent_gates(self):
        for mutate, reason in (
            (lambda b: b['rows'][-1]['checks'].update(use=False), 'previously_correct_actual_behavior_regressed'),
            (lambda b: b['rows'][-1]['risks'].update(wrong_add=True), 'risk_increased_wrong_add'),
            (lambda b: b['rows'][0]['cost'].update(tokens=1000), 'candidate_token_cost_above_limit'),
            (lambda b: b['rows'][0]['cost'].update(latency_ms=1000), 'candidate_latency_above_limit'),
            (lambda b: b['rows'][0]['cost'].update(tokens=None), 'comparison_cost_unknown'),
        ):
            instance = optimizer()
            before = feedback_fixture()
            _, candidate = stage(instance, before)
            after = synthetic_comparison(before, candidate)
            mutate(after)
            decision = instance.evaluate(after)
            with self.subTest(reason=reason):
                self.assertFalse(decision['adopt'])
                self.assertIn(reason, decision['reasons'])
                self.assertEqual(instance.active, PolicySnapshot())

    def test_annotation_changes_invalidate_the_comparison(self):
        instance = optimizer()
        before = feedback_fixture()
        _, candidate = stage(instance, before)
        after = synthetic_comparison(before, candidate)
        after['rows'][0]['expected']['action'] = 'noop'
        with self.assertRaisesRegex(FeedbackRejected, 'invalid_comparison'):
            instance.evaluate(after)
        self.assertEqual(instance.audit()['status'], 'rejected')

    def test_capacity_and_policy_saturation(self):
        before = feedback_fixture()
        saturated = PolicySnapshot(3, (('R1', 'An existing rule.'),))
        before['policy_sha256'] = saturated.sha256
        self.assertEqual(optimizer(policy=saturated).prepare(before)['reason'], 'policy_version_capacity')
        for size in (513, 9000):
            instance = optimizer()
            prepared = instance.prepare(feedback_fixture())
            instance.generation_request('Fixed contract.')
            proposal = scripted_proposal(prepared)
            proposal['patch']['text'] = 'x' * size
            with self.assertRaises(FeedbackRejected):
                instance.submit_response(prepared['packet_sha256'], json.dumps(proposal))
            self.assertEqual(instance.active, PolicySnapshot())
        before = feedback_fixture()
        before['planned'] *= 11
        before['rows'] *= 11
        with self.assertRaises(FeedbackRejected):
            optimizer().prepare(before)

    def test_support_objects_float_coordinates_and_multiple_errors_are_rejected(self):
        for mutate in (
            lambda p: p.update(support=[dict(zip(('dialogue', 'turn', 'repeat', 'root'), p['support'][0]))]),
            lambda p: p['support'][0].__setitem__(1, 1.0),
            lambda p: p['support'].append(deepcopy(p['support'][0])),
        ):
            instance = optimizer()
            prepared = instance.prepare(feedback_fixture())
            instance.generation_request('Fixed contract.')
            proposal = scripted_proposal(prepared)
            mutate(proposal)
            with self.assertRaises(FeedbackRejected):
                instance.submit_response(prepared['packet_sha256'], json.dumps(proposal))


if __name__ == '__main__':
    unittest.main()
