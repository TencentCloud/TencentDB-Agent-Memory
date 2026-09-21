"""Bounded static artifact parsing. No model, policy selection, or storage."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

MAX_FILE_BYTES = 4096


class PolicyRejected(ValueError):
    """Fixed error code only."""


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(',', ':')).encode('utf-8')


@dataclass(frozen=True)
class StaticPolicy:
    generation: int = 0
    rules: tuple = ()
    artifact_sha256: str | None = None

    @property
    def rule_texts(self):
        return tuple(text for _, text in self.rules)

    def policy_object(self):
        return {'generation': self.generation,
                'rules': [{'rule_id': rid, 'text': text} for rid, text in self.rules]}

    @property
    def policy_sha256(self):
        return hashlib.sha256(encoded(self.policy_object())).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyRejected('policy_duplicate_key')
        result[key] = value
    return result


def parse_policy(raw):
    if type(raw) is not bytes or len(raw) > MAX_FILE_BYTES:
        raise PolicyRejected('policy_file_capacity')
    try:
        value = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(PolicyRejected('policy_nonfinite')))
    except PolicyRejected:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise PolicyRejected('policy_json') from None
    count = 0

    def visit(item, depth):
        nonlocal count
        count += 1
        if depth > 4 or count > 64:
            raise PolicyRejected('policy_json_capacity')
        if type(item) is dict:
            for key, child in item.items():
                key.encode('utf-8'); visit(child, depth + 1)
        elif type(item) is list:
            for child in item:
                visit(child, depth + 1)
        elif type(item) is str:
            item.encode('utf-8')
    try:
        visit(value, 1)
    except UnicodeError:
        raise PolicyRejected('policy_unicode') from None
    if (type(value) is not dict or set(value) != {'schema_version', 'artifact_kind', 'generation', 'rules'}
            or type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['artifact_kind'] != 'static_memory_rules'
            or type(value['generation']) is not int or not 0 <= value['generation'] <= 3
            or type(value['rules']) is not list or len(value['rules']) > 8):
        raise PolicyRejected('policy_schema')
    rules = []
    for rule in value['rules']:
        if (type(rule) is not dict or set(rule) != {'rule_id', 'text'}
                or type(rule['rule_id']) is not str or re.fullmatch(r'R[1-8]', rule['rule_id']) is None
                or type(rule['text']) is not str or not rule['text'].strip()):
            raise PolicyRejected('policy_rule_schema')
        rules.append((rule['rule_id'], rule['text']))
    if len({rid for rid, _ in rules}) != len(rules) or (value['generation'] == 0 and rules):
        raise PolicyRejected('policy_identity')
    # Keep the actual intent interface's limits as the execution authority.
    from shared.segmented_trajectory_intent import freeze_rules, IntentRejected
    try:
        freeze_rules([text for _, text in rules])
    except IntentRejected:
        raise PolicyRejected('policy_rule_capacity') from None
    return StaticPolicy(value['generation'], tuple(rules), hashlib.sha256(raw).hexdigest())


def load_policy(path=None):
    if path is None:
        return StaticPolicy()
    with Path(path).open('rb') as stream:
        return parse_policy(stream.read(MAX_FILE_BYTES + 1))
