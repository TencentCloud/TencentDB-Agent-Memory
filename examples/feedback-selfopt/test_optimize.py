"""Run the installed SDK against actual isolated SQLite, with scripted callbacks."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import demo
import optimize
from tencentdb_agent_memory.feedback import PolicySnapshot

CORE = Path(__file__).resolve().parents[2] / 'MemoryCore'


class OptimizerConnectionTests(unittest.TestCase):
    def test_off_mode_has_no_business_io(self):
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('off read')), \
                patch.object(Path, 'mkdir', side_effect=AssertionError('off mkdir')):
            self.assertEqual(optimize.run(output='unused')['mode'], 'off')

    def test_actual_commit_state_delivery_feedback_and_inactive_candidate(self):
        with tempfile.TemporaryDirectory(prefix='memory-feedback-test-') as temporary:
            output = Path(temporary) / 'comparison'
            result = optimize.run(fixture=True, core=CORE, output=output)
            self.assertEqual((result['before_correct'], result['after_correct']), (4, 6))
            self.assertEqual(result['comparison']['corrected_support'], [['D1', 3, 1]])
            self.assertEqual(result['final_policy_version'], 0)
            self.assertFalse(result['optimization_usefulness_established'])
            self.assertEqual((result['model_calls'], result['http_requests']), (0, 0))
            # Machine timing can reject training adoption; it must remain visible.
            self.assertTrue(set(result['comparison']['reasons']) <= {'candidate_latency_above_limit'})
            batch = optimize.project_feedback(output / 'baseline', PolicySnapshot())
            self.assertEqual([r['turn'] for r in batch['rows'] if r['origin'] == 'current'], [3])
            self.assertEqual([r['turn'] for r in batch['rows'] if r['origin'] == 'propagated'], [4])
            rows = optimize.read_rows(output / 'baseline' / 'rows.private.jsonl')
            deliveries = optimize.read_rows(output / 'baseline' / 'deliveries.private.jsonl')
            for case in ('source', 'wire', 'continuity', 'unknown_content', 'missing'):
                altered = deepcopy(rows)
                if case == 'source':
                    altered[0]['host']['user'] = 'Altered original source'
                elif case == 'wire':
                    altered[0]['host']['wire']['request_hash'] = '0' * 64
                elif case == 'continuity':
                    altered[1]['host']['before_state']['totalHeads'] = 99
                elif case == 'unknown_content':
                    altered[0]['host']['after_state']['entries'][0]['content'] = 'No annotated meaning'
                else:
                    altered.pop()
                with self.subTest(case=case), patch.object(optimize, 'read_rows', side_effect=[altered, deliveries]), \
                        self.assertRaises(demo.ExampleRejected):
                    optimize.project_feedback(output / 'baseline', PolicySnapshot())


if __name__ == '__main__':
    unittest.main()
