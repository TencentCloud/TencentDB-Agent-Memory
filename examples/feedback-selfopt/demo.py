"""Default-off portable connection example. Explicit fixture only, no network."""
import sys
sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

MAX_FILE_BYTES = 2 * 1048576
MAX_JSON_BYTES = 8 * 1048576
DEADLINE_SECONDS = 120
MAX_RPC = 64
FILES = frozenset(('configuration.json', 'rows.private.jsonl', 'deliveries.private.jsonl',
                  'bridge-audit.jsonl', 'summary.json', 'failure.json'))


class ExampleRejected(RuntimeError):
    """Fixed diagnostic code."""


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def error_code(exc):
    from policy import PolicyRejected
    from fixture import FixtureRejected
    from shared.hermes_memory_host import HostRejected
    if isinstance(exc, (ExampleRejected, PolicyRejected, FixtureRejected, HostRejected)):
        code = str(exc)
        if re.fullmatch(r'[a-z0-9_]{1,96}', code):
            return code
    return 'filesystem_error' if isinstance(exc, OSError) else 'fixture_unclassified_failure'


class EvidenceWriter:
    """Exclusive bounded files. Failed writes are never retried or overwritten."""
    def __init__(self, directory):
        self.directory = directory
        self.bytes_reserved = 0

    def write(self, name, value):
        if name not in FILES:
            raise ExampleRejected('evidence_filename')
        raw = (b''.join(encoded(row) + b'\n' for row in value)
               if name.endswith('.jsonl') else encoded(value) + b'\n')
        if len(raw) > MAX_FILE_BYTES or self.bytes_reserved + len(raw) > MAX_JSON_BYTES:
            raise ExampleRejected('evidence_capacity')
        self.bytes_reserved += len(raw)
        with (self.directory / name).open('xb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


class BoundedBridge:
    """Counts real attempts and delegates unchanged operations to ChainProcess."""
    def __init__(self, bridge, deadline):
        self.bridge, self.deadline = bridge, deadline
        self.calls = 0
        self.events = []
        self.admission_error = None

    def request(self, operation, args):
        # The existing RPC has an 8s wait; reserve another 4s for child cleanup.
        if time.monotonic() + 12 >= self.deadline:
            self.admission_error = 'fixture_deadline'
            raise ExampleRejected('fixture_deadline')
        if self.calls >= MAX_RPC:
            self.admission_error = 'fixture_rpc_capacity'
            raise ExampleRejected('fixture_rpc_capacity')
        self.calls += 1
        started = time.monotonic()
        event = {'ordinal': self.calls, 'operation': operation,
                 'request_args_sha256': hashlib.sha256(encoded(args)).hexdigest(),
                 'status': 'error', 'response_sha256': None, 'error': None}
        self.events.append(event)
        try:
            result = self.bridge.request(operation, args)
            event.update(status='pass', response_sha256=hashlib.sha256(encoded(result)).hexdigest())
            return result
        except Exception as exc:
            event['error'] = error_code(exc)
            raise
        finally:
            event['latency_ms'] = (time.monotonic() - started) * 1000


def _new_output(output):
    if output is None:
        raise ExampleRejected('new_output_required')
    path = Path(output).absolute()
    # Check existing ancestors, including Windows junctions, before resolving.
    for part in (path, *path.parents):
        if part.is_symlink() or (part.exists() and getattr(part.lstat(), 'st_file_attributes', 0) & 1024):
            raise ExampleRejected('output_link_forbidden')
    parent = path.parent.resolve(strict=True)
    target = parent / path.name
    if target.exists():
        raise ExampleRejected('new_output_required')
    return target


def _sources(core):
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / 'shared-sources.json').read_bytes())
    for name, expected in manifest['modules'].items():
        if hashlib.sha256((here / 'shared' / name).read_bytes()).hexdigest() != expected:
            raise ExampleRejected('shared_source_integrity')
    return {'shared_module_sha256': dict(manifest['modules']),
            'bridge_sha256': hashlib.sha256((core / 'src/core/feedback/chain-stdio-bridge.ts').read_bytes()).hexdigest(),
            'memorycore_package_sha256': hashlib.sha256((core / 'package.json').read_bytes()).hexdigest()}


def run_example(*, fixture=False, policy=None, core=None, node='node', output=None,
                classifier_factory=None):
    if fixture is False:
        return {'mode': 'off', 'status': 'off', 'model_calls': 0, 'http_requests': 0}
    if fixture is not True:
        raise ExampleRejected('fixture_flag_type')
    # Application modules and all business I/O stay behind the explicit flag.
    from policy import load_policy
    from fixture import TURNS, QUERY, MODEL, ReplayClassifier, LocalSink, envelope
    from shared.hermes_memory_host import ChainProcess, WireReceiptGate
    from shared.trajectory_memory_host import TrajectoryMemoryHost
    from shared.segmented_trajectory_intent import SegmentedTrajectoryIntent

    started = time.monotonic(); deadline = started + DEADLINE_SECONDS
    frozen = load_policy(policy)
    core_path = Path(core or 'MemoryCore').resolve(strict=True)
    if (not (core_path / 'src/core/feedback/chain-stdio-bridge.ts').is_file()
            or not (core_path / 'node_modules/tsx/package.json').is_file()):
        raise ExampleRejected('installed_memorycore_required')
    binary = shutil.which(str(node))
    if binary is None:
        raise ExampleRejected('node_binary_required')
    target = _new_output(output)
    provenance = _sources(core_path)
    target.mkdir(exist_ok=False)
    database = target / 'memory.sqlite'
    if database.resolve().parent != target.resolve() or database.exists():
        raise ExampleRejected('new_isolated_database_required')
    writer = EvidenceWriter(target)
    scope = {'teamId': 'feedback-example', 'userId': 'fixture-user',
             'agentId': 'fixture-agent', 'taskId': 'fixture-task'}
    summary = {'context': 'engineering_fixture', 'status': 'error',
        'delivery_kind': 'local_inprocess_fixture_sink', 'gate_status_kind': 'simulated_http_shape',
        'actual_provider_delivery': False, 'model_calls': 0, 'sdk_calls': 0, 'http_requests': 0,
        'token_usage': None, 'token_usage_status': 'not_applicable_no_model',
        'optimization_usefulness_established': False, 'retry_count': 0,
        'planned_turns': 6, 'completed_turns': 0, 'node_subprocesses': 0,
        'classifier_callbacks': 0, 'sink_callbacks': 0, 'bridge_rpc_attempts': 0,
        'policy_sha256': frozen.policy_sha256, 'failures': []}
    rows = []; process = None; bridge = None; host = None; classifier = None; sink = None
    failed = None
    try:
        writer.write('configuration.json', {**summary, 'policy': frozen.policy_object(),
            'policy_artifact_sha256': frozen.artifact_sha256,
            'sample_policy_origin': 'caller_supplied_static_not_selected_or_learned',
            'scope': scope, 'database': 'memory.sqlite', 'rules_frozen_during_run': True,
            'provenance': provenance, 'limits': {'turns': 6, 'rpc': MAX_RPC,
                'deadline_seconds': DEADLINE_SECONDS, 'json_file_bytes': MAX_FILE_BYTES,
                'all_json_bytes': MAX_JSON_BYTES, 'concurrency': 1}})
        if time.monotonic() + 12 >= deadline:
            raise ExampleRejected('fixture_deadline')
        process = ChainProcess(binary, core_path, database, scope,
                               deadline_ms=max(1, int((deadline - time.monotonic()) * 1000)))
        summary['node_subprocesses'] = 1
        bridge = BoundedBridge(process, deadline)
        initial = bridge.request('snapshot', {})
        if initial['entries'] or initial['totalHeads'] != 0:
            raise ExampleRejected('fixture_initial_store_not_empty')
        classifier = (classifier_factory or ReplayClassifier)(frozen.rule_texts); sink = LocalSink()
        intent = SegmentedTrajectoryIntent(classifier, mode='isolated', policy_rules=frozen.rule_texts)
        gate = WireReceiptGate(MODEL, protocol='chat_completions')
        host = TrajectoryMemoryHost(enabled=True, bridge=bridge, session_id='portable-fixture')
        for turn in TURNS:
            row = host.run_turn(turn.user, query=QUERY, probe=turn.probe, intent=intent,
                                answerer=sink, gate=gate)
            rows.append(envelope(row)); summary['completed_turns'] += 1
        final = bridge.request('snapshot', {})
        if final != rows[-1]['host']['after_state']:
            raise ExampleRejected('fixture_final_state_mismatch')
        summary.update(status='pass', final_state=final,
                       action_counts={action: sum(r['host'].get('decision', {}).get('action') == action
                           for r in rows if r['host'].get('decision')) for action in ('add', 'update', 'retire')})
    except Exception as exc:
        failed = {'code': error_code(exc), 'phase': 'fixture_execution'}
        summary['failures'].append(failed)
        if host is not None and host.last_failed_evidence is not None:
            rows.append(envelope(host.last_failed_evidence))
    finally:
        if process is not None:
            try:
                process.close(force=failed is not None or time.monotonic() >= deadline)
            except Exception as exc:
                summary['failures'].append({'code': error_code(exc), 'phase': 'child_close'})
        summary.update(classifier_callbacks=classifier.calls if classifier else 0,
            sink_callbacks=sink.callback_attempts if sink else 0,
            sink_consumptions=sink.calls if sink else 0, bridge_rpc_attempts=bridge.calls if bridge else 0,
            bridge_admission_error=bridge.admission_error if bridge else None,
            last_memory_mutation_status=rows[-1]['host'].get('memory_mutation_status') if rows else None,
            elapsed_ms=(time.monotonic() - started) * 1000)
        for name, value in (('rows.private.jsonl', rows),
                            ('deliveries.private.jsonl', sink.records if sink else []),
                            ('bridge-audit.jsonl', bridge.events if bridge else [])):
            try:
                writer.write(name, value)
            except Exception as exc:
                summary['failures'].append({'code': error_code(exc), 'phase': 'evidence_export', 'file': name})
        if summary['failures']:
            summary['status'] = 'error'
        try:
            writer.write('summary.json', summary)
        except Exception as exc:
            summary['failures'].append({'code': error_code(exc), 'phase': 'summary_export'})
            summary['status'] = 'error'
        if summary['failures']:
            try:
                writer.write('failure.json', {**summary, 'final_status': 'error_no_replay',
                    'last_observed_row': rows[-1] if rows else None})
            except Exception:
                summary['failure_evidence_unwritable'] = True
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', action='store_true')
    for name in ('policy', 'core', 'output'):
        parser.add_argument('--' + name)
    parser.add_argument('--node', default='node')
    args = parser.parse_args(argv)
    if not args.fixture:
        return 0
    try:
        result = run_example(**vars(args))
    except Exception as exc:
        result = {'status': 'error', 'context': 'engineering_fixture', 'code': error_code(exc),
                  'model_calls': 0, 'http_requests': 0, 'actual_provider_delivery': False}
    # Only bounded counts/codes, never raw private trajectories or paths.
    print(json.dumps({k: v for k, v in result.items() if k not in ('final_state',)}))
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
