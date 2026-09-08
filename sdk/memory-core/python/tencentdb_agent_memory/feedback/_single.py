"""One verified current error can request one inactive, bounded hypothesis.

The host authenticates authors and verifies raw sources, commits, snapshots and
delivery. This core validates their bindings and declared consistency, not their
truth. It deliberately separates proposal eligibility from complete training
adoption. No model, store, network or filesystem is imported.
"""

from collections import Counter, defaultdict
from copy import deepcopy
from fractions import Fraction
import hashlib
import math
import re

from ._core import (
    FAMILIES,
    FeedbackUpdateSession,
    PolicySnapshot,
    UpdateRejected,
    bounded_text,
    canonical,
    fingerprint,
    identifier,
)


SCHEMA = "source-bound-single-feedback-v1"
MECHANISM = "verified_single_root_exploration_v1"
RISKS = (
    "wrong_add",
    "wrong_change",
    "target_mismatch",
    "unauthorized_persistence",
    "stale_active",
)
CHECKS = ("state", "commit", "use")
CAUSES = (
    "none",
    "policy_semantic",
    "policy_content",
    "interface",
    "execution",
    "retrieval",
    "answer",
    "infrastructure",
    "integrity",
)
FIELDS = {
    "dialogue",
    "lineage",
    "turn",
    "repeat",
    "root",
    "origin",
    "authority",
    "authority_kind",
    "annotation_sha256",
    "source_sha256",
    "trace_sha256",
    "text",
    "expected",
    "predicted",
    "observed",
    "cause",
    "family",
    "action",
    "probe",
    "checks",
    "risks",
    "cost",
}


def require(value, reason):
    if not value:
        raise UpdateRejected(reason)


def coordinate(row):
    return row["dialogue"], row["turn"], row["repeat"]


def root_key(row):
    return row["lineage"], row["dialogue"], row["root"]


def digest(value):
    require(
        type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
        "feedback_digest",
    )


def known(row):
    return (
        row["observed"]
        and all(
            type(row["checks"][k]) is bool for k in CHECKS if k != "use" or row["probe"]
        )
        and all(type(v) is bool for v in row["risks"].values())
    )


def support(row):
    return (
        known(row)
        and row["origin"] == "current"
        and row["cause"] in ("policy_semantic", "policy_content")
        and row["family"] in FAMILIES
        and row["predicted"] is not None
        and row["checks"]["state"] is False
        and row["checks"]["commit"] is False
    )


def correct_control(row):
    return (
        known(row)
        and row["checks"]["state"] is True
        and row["checks"]["commit"] is True
        and (not row["probe"] or row["checks"]["use"] is True)
        and not any(row["risks"].values())
        and row["cause"] == "none"
    )


def validate_batch(batch, *, policy, interface_id, allowed_sources):
    require(type(policy) is PolicySnapshot, "feedback_policy")
    bounded_text(interface_id, 96)
    require(
        type(allowed_sources) in (tuple, list) and 1 <= len(allowed_sources) <= 8,
        "feedback_sources",
    )
    for source in allowed_sources:
        identifier(source)
    require(
        type(batch) is dict
        and set(batch)
        == {"schema", "policy_sha256", "interface_id", "split", "planned", "rows"},
        "feedback_batch_fields",
    )
    require(len(canonical(batch).encode()) <= 262144, "feedback_capacity")
    value = deepcopy(batch)
    require(
        value["schema"] == SCHEMA and value["split"] == "train",
        "feedback_schema_or_split",
    )
    require(
        value["policy_sha256"] == policy.sha256
        and value["interface_id"] == interface_id,
        "feedback_binding",
    )
    planned, rows = value["planned"], value["rows"]
    require(
        type(planned) is list and 1 <= len(planned) <= 128, "feedback_plan_capacity"
    )
    require(
        type(rows) is list and len(rows) == len(planned),
        "feedback_missing_planned_observation",
    )
    plan = []
    branches = defaultdict(list)
    for item in planned:
        require(type(item) is list and len(item) == 3, "feedback_coordinate")
        dialogue, turn, repeat = item
        identifier(dialogue)
        require(
            type(turn) is int
            and 1 <= turn <= 128
            and type(repeat) is int
            and 1 <= repeat <= 3,
            "feedback_coordinate",
        )
        plan.append(tuple(item))
        branches[(dialogue, repeat)].append(turn)
    require(
        len(set(plan)) == len(plan) and len(branches) <= 32,
        "feedback_duplicate_or_branch_capacity",
    )
    plan_set = set(plan)
    dialogue_turns = {}
    for (dialogue, _), turns in branches.items():
        require(
            sorted(turns) == list(range(1, max(turns) + 1)),
            "feedback_noncontiguous_plan",
        )
        old = dialogue_turns.setdefault(dialogue, sorted(turns))
        require(old == sorted(turns), "feedback_repeat_plan_changed")
    by_key = {}
    lineages = {}
    for row in rows:
        require(type(row) is dict and set(row) == FIELDS, "feedback_observation_fields")
        for field in ("dialogue", "lineage", "root", "authority"):
            identifier(row[field])
        require(
            row["authority"] in allowed_sources
            and row["authority_kind"] in ("human", "controlled_author"),
            "feedback_authority",
        )
        require(
            type(row["turn"]) is int and type(row["repeat"]) is int,
            "feedback_coordinate",
        )
        key = coordinate(row)
        require(
            key in plan_set and key not in by_key, "feedback_unplanned_or_duplicate"
        )
        require(
            lineages.setdefault(row["dialogue"], row["lineage"]) == row["lineage"],
            "feedback_lineage_changed",
        )
        require(
            row["origin"] in ("current", "propagated", "none")
            and row["cause"] in CAUSES,
            "feedback_attribution",
        )
        require(
            row["family"] is None
            or type(row["family"]) is str
            and row["family"] in FAMILIES,
            "feedback_family",
        )
        require(row["action"] in ("add", "update", "retire", "noop"), "feedback_action")
        require(
            type(row["observed"]) is bool and type(row["probe"]) is bool,
            "feedback_boolean",
        )
        bounded_text(row["text"], 8192)
        digest(row["annotation_sha256"])
        require(
            row["source_sha256"] == hashlib.sha256(row["text"].encode()).hexdigest(),
            "feedback_source_binding",
        )
        if row["trace_sha256"] is not None:
            digest(row["trace_sha256"])
        require(
            not row["observed"] or row["trace_sha256"] is not None,
            "feedback_observation_without_trace",
        )
        require(
            type(row["expected"]) is dict
            and len(canonical(row["expected"]).encode()) <= 2048,
            "feedback_expected",
        )
        require(
            row["predicted"] is None
            or type(row["predicted"]) is dict
            and len(canonical(row["predicted"]).encode()) <= 2048,
            "feedback_predicted",
        )
        for field, names in (("checks", CHECKS), ("risks", RISKS)):
            values = row[field]
            require(
                type(values) is dict and set(values) == set(names),
                "feedback_measurement_fields",
            )
            require(
                all(v is None or type(v) is bool for v in values.values()),
                "feedback_tristate",
            )
            require(
                row["observed"] or all(v is None for v in values.values()),
                "feedback_unobserved_measurement",
            )
        require(
            row["probe"] or row["checks"]["use"] is None, "feedback_unplanned_probe"
        )
        require(
            type(row["cost"]) is dict and set(row["cost"]) == {"tokens", "latency_ms"},
            "feedback_cost",
        )
        tokens, latency = row["cost"]["tokens"], row["cost"]["latency_ms"]
        require(
            tokens is None or type(tokens) is int and tokens >= 0, "feedback_tokens"
        )
        require(
            latency is None
            or type(latency) in (int, float)
            and math.isfinite(latency)
            and latency >= 0,
            "feedback_latency",
        )
        by_key[key] = row
    require(set(by_key) == set(plan), "feedback_missing_plan")
    value["rows"] = [by_key[key] for key in plan]
    return value


def prepare_feedback(batch, *, policy, interface_id, allowed_sources, enabled=False):
    require(type(enabled) is bool, "feedback_enable")
    if not enabled:
        return dict(eligible=False, reason="off", model_requests=0)
    value = validate_batch(
        batch, policy=policy, interface_id=interface_id, allowed_sources=allowed_sources
    )
    if policy.version >= 3:
        return dict(eligible=False, reason="policy_version_capacity", model_requests=0)
    rows = value["rows"]
    if any(r["cause"] == "integrity" for r in rows):
        return dict(
            eligible=False, reason="feedback_integrity_failure", model_requests=0
        )
    errors = [
        r for family in FAMILIES for r in rows if support(r) and r["family"] == family
    ]
    if not errors:
        return dict(
            eligible=False, reason="no_verified_current_fact_error", model_requests=0
        )
    selected = errors[0]
    controls = []
    seen = set()
    for actions in (("add", "update"), ("noop",)):
        row = next(
            (
                r
                for r in rows
                if correct_control(r)
                and r["action"] in actions
                and (r["lineage"], r["dialogue"], r["turn"]) not in seen
            ),
            None,
        )
        if row is None:
            return dict(
                eligible=False,
                reason="write_and_noop_controls_required",
                model_requests=0,
            )
        controls.append(row)
        seen.add((row["lineage"], row["dialogue"], row["turn"]))
    for row in rows:
        case = row["lineage"], row["dialogue"], row["turn"]
        if len(controls) >= 4:
            break
        if correct_control(row) and case not in seen:
            controls.append(row)
            seen.add(case)
    packet = dict(
        mechanism=MECHANISM,
        parent_sha256=policy.sha256,
        parent={"version": policy.version, "rules": [list(r) for r in policy.rules]},
        interface_id=interface_id,
        selected_family=selected["family"],
        errors=[deepcopy(selected)],
        correct_controls=deepcopy(controls),
        feedback_sha256=fingerprint(value),
        denominators=dict(
            planned_rows=len(rows),
            known_rows=sum(known(r) for r in rows),
            unique_dialogues=len({r["dialogue"] for r in rows}),
            unique_current_roots=len({root_key(r) for r in errors}),
            propagated_rows=sum(r["origin"] == "propagated" for r in rows),
        ),
        annotation_truth_verified_by_core=False,
        proposal_is_not_adoption=True,
        training_only=True,
        final_effect_proven=False,
    )
    if len(canonical(packet).encode()) > 32768:
        return dict(
            eligible=False, reason="generation_context_capacity", model_requests=0
        )
    return dict(
        eligible=True,
        reason="one_verified_current_root",
        packet=packet,
        packet_sha256=fingerprint(packet),
    )


def _weights(rows):
    counts = defaultdict(Counter)
    for row in rows:
        counts[row["dialogue"]][row["repeat"]] += 1
    return {
        coordinate(r): Fraction(
            1,
            len(counts)
            * len(counts[r["dialogue"]])
            * counts[r["dialogue"]][r["repeat"]],
        )
        for r in rows
    }


def _p95(values):
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def assess_candidate(
    before, after, *, prepared, parent, candidate, interface_id, allowed_sources
):
    left = validate_batch(
        before,
        policy=parent,
        interface_id=interface_id,
        allowed_sources=allowed_sources,
    )
    right = validate_batch(
        after,
        policy=candidate,
        interface_id=interface_id,
        allowed_sources=allowed_sources,
    )
    packet = prepared["packet"]
    require(
        prepared["packet_sha256"] == fingerprint(packet)
        and packet["feedback_sha256"] == fingerprint(left)
        and packet["parent_sha256"] == parent.sha256
        and packet["mechanism"] == MECHANISM,
        "comparison_prepared_binding",
    )
    require(left["planned"] == right["planned"], "comparison_plan_changed")
    rows, following = left["rows"], right["rows"]
    stable = (
        "dialogue",
        "lineage",
        "turn",
        "repeat",
        "authority",
        "authority_kind",
        "annotation_sha256",
        "source_sha256",
        "text",
        "expected",
        "action",
        "probe",
    )
    for first, second in zip(rows, following):
        require(
            all(first[k] == second[k] for k in stable), "comparison_annotation_changed"
        )
    all_rows = rows + following
    if any(
        not known(r) or r["cause"] in ("integrity", "infrastructure") for r in all_rows
    ):
        return dict(
            adopt=False,
            reasons=["comparison_measurements_missing"],
            training_only=True,
            final_effect_proven=False,
        )
    if any(v is None for r in all_rows for v in r["cost"].values()):
        return dict(
            adopt=False,
            reasons=["comparison_cost_unknown"],
            training_only=True,
            final_effect_proven=False,
        )
    weights = _weights(rows)
    gain = Fraction()
    by_dialogue = defaultdict(Fraction)
    reasons = []
    require(len(packet["errors"]) == 1, "comparison_support_count")
    selected = root_key(packet["errors"][0])
    fixed = []
    required = []
    for first, second in zip(rows, following):
        key = coordinate(first)
        difference = int(second["checks"]["state"]) - int(first["checks"]["state"])
        gain += weights[key] * difference
        by_dialogue[first["dialogue"]] += weights[key] * difference
        if any(
            first["checks"][k] is True and second["checks"][k] is not True
            for k in CHECKS
        ):
            reasons.append("previously_correct_actual_behavior_regressed")
        for risk in RISKS:
            if second["risks"][risk] and not first["risks"][risk]:
                reasons.append("risk_increased_" + risk)
        if support(first) and root_key(first) == selected:
            required.append(key)
            if second["checks"]["state"] and second["checks"]["commit"]:
                fixed.append(key)
    if not required or fixed != required:
        reasons.append("selected_root_not_fully_corrected")
    if gain < Fraction(1, 20):
        reasons.append("fact_state_gain_below_five_pp")
    if any(change < 0 for change in by_dialogue.values()):
        reasons.append("dialogue_regressed")
    before_tokens = sum(r["cost"]["tokens"] for r in rows)
    after_tokens = sum(r["cost"]["tokens"] for r in following)
    before_p95 = _p95([r["cost"]["latency_ms"] for r in rows])
    after_p95 = _p95([r["cost"]["latency_ms"] for r in following])
    if after_tokens * 4 > before_tokens * 5:
        reasons.append("candidate_token_cost_above_limit")
    if after_p95 * 2 > before_p95 * 3:
        reasons.append("candidate_latency_above_limit")
    return dict(
        adopt=not reasons,
        reasons=sorted(set(reasons)),
        state_gain_pp=float(100 * gain),
        required_state_gain_pp=5,
        state_gain_pp_by_dialogue={
            d: float(100 * v * len(by_dialogue)) for d, v in by_dialogue.items()
        },
        corrected_support=[list(k) for k in fixed],
        comparison_tokens=dict(before=before_tokens, after=after_tokens),
        comparison_p95_ms=dict(before=before_p95, after=after_p95),
        generation_cost_included_in_comparison=False,
        parent_sha256=parent.sha256,
        candidate_sha256=candidate.sha256,
        training_only=True,
        final_effect_proven=False,
    )


class SingleFeedbackExplorationSession(FeedbackUpdateSession):
    """Research prototype: default off, one proposal, no store/transport ownership."""

    def __init__(self, *, policy=None, interface_id, allowed_sources, enabled=False):
        super().__init__(
            policy=policy,
            interface_id=interface_id,
            allowed_sources=allowed_sources,
            enabled=enabled,
        )
        self._mechanism_id = MECHANISM

    def _prepare_feedback(self, batch):
        return prepare_feedback(
            batch,
            policy=self._parent,
            interface_id=self.interface_id,
            allowed_sources=self.sources,
            enabled=True,
        )

    def _validate_feedback(self, batch):
        return validate_batch(
            batch,
            policy=self._parent,
            interface_id=self.interface_id,
            allowed_sources=self.sources,
        )

    def _assess_feedback(self, after):
        return assess_candidate(
            self._before,
            after,
            prepared=self._prepared,
            parent=self._parent,
            candidate=self._candidate,
            interface_id=self.interface_id,
            allowed_sources=self.sources,
        )
