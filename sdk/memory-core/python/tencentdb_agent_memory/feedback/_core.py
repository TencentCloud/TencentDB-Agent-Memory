"""Bounded feedback selection and adoption rules, independent of model and storage providers.

The host supplies verified annotation/trace references. This module checks
identity and consistency, not the truth of annotations or files behind those
references. Model confidence, thanks and silence are not feedback authorities.
No model client, storage, endpoint, path or research dataset is imported here.
"""

from copy import deepcopy
from dataclasses import asdict, dataclass
import hashlib
import json
import re
import threading

FAMILIES = (
    "durable_change_missed",
    "temporary_or_third_party_persisted",
    "memory_vs_answer_object_confused",
    "scope_or_target_confused",
    "wrong_source_fact_selected",
    "obsolete_state_not_replaced_or_retired",
)


class UpdateRejected(ValueError):
    pass


def canonical(value):
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise UpdateRejected("invalid_json_value") from None


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def bounded_text(value, cap):
    if type(value) is not str or not value.strip() or "\x00" in value:
        raise UpdateRejected("text_invalid")
    try:
        if len(value) > cap or len(value.encode()) > cap:
            raise UpdateRejected("text_capacity")
    except UnicodeError:
        raise UpdateRejected("text_encoding") from None
    return value


def identifier(value):
    if type(value) is not str or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}", value
    ):
        raise UpdateRejected("identifier")
    return value


@dataclass(frozen=True)
class PolicySnapshot:
    version: int = 0
    rules: tuple[tuple[str, str], ...] = ()

    def __post_init__(self):
        if type(self.version) is not int or not 0 <= self.version <= 3:
            raise UpdateRejected("policy_version")
        if type(self.rules) is not tuple or len(self.rules) > 8:
            raise UpdateRejected("policy_capacity")
        seen = set()
        total = 0
        for rule in self.rules:
            if type(rule) is not tuple or len(rule) != 2:
                raise UpdateRejected("rule_shape")
            rid, value = rule
            if type(rid) is not str or not re.fullmatch("R[1-8]", rid) or rid in seen:
                raise UpdateRejected("rule_identity")
            seen.add(rid)
            total += len(bounded_text(value, 512).encode())
        if total > 2048 or self.version == 0 and self.rules:
            raise UpdateRejected("policy_capacity")

    @property
    def sha256(self):
        return fingerprint(asdict(self))

    def dump(self):
        return canonical(asdict(self))

    @classmethod
    def load(cls, raw):
        bounded_text(raw, 8192)

        def pairs(items):
            value = {}
            for k, v in items:
                if k in value:
                    raise UpdateRejected("duplicate_json_key")
                value[k] = v
            return value

        try:
            value = json.loads(raw, object_pairs_hook=pairs)
            if set(value) != {"version", "rules"} or type(value["rules"]) is not list:
                raise UpdateRejected("policy_shape")
            return cls(
                value["version"],
                tuple(tuple(r) if type(r) is list else r for r in value["rules"]),
            )
        except (TypeError, KeyError, ValueError, RecursionError):
            raise UpdateRejected("policy_load_rejected") from None


def apply_patch(parent, patch):
    if (
        type(parent) is not PolicySnapshot
        or type(patch) is not dict
        or set(patch) != {"op", "rule_id", "text"}
    ):
        raise UpdateRejected("patch_contract")
    if parent.version >= 3:
        raise UpdateRejected("policy_version_capacity")
    op, rid, value = patch["op"], patch["rule_id"], patch["text"]
    rules = list(parent.rules)
    if (
        op not in ("add", "replace", "remove")
        or type(rid) is not str
        or not re.fullmatch("R[1-8]", rid)
    ):
        raise UpdateRejected("patch_operation")
    indexes = [i for i, r in enumerate(rules) if r[0] == rid]
    if op == "add":
        if indexes:
            raise UpdateRejected("rule_already_present")
        rules.append((rid, value))
    else:
        if not indexes:
            raise UpdateRejected("rule_missing")
        index = indexes[0]
        if op == "remove":
            if value is not None:
                raise UpdateRejected("remove_has_text")
            rules.pop(index)
        else:
            if value == rules[index][1]:
                raise UpdateRejected("unchanged_rule")
            rules[index] = (rid, value)
    return PolicySnapshot(parent.version + 1, tuple(rules))


def validate_support(value):
    """Exact internal coordinates; bool/float are not integer coordinates."""
    if type(value) is not list or len(value) != 1:
        raise UpdateRejected("support_shape")
    for item in value:
        if (
            type(item) is not list
            or len(item) != 4
            or type(item[1]) is not int
            or not 1 <= item[1] <= 128
            or type(item[2]) is not int
            or not 1 <= item[2] <= 3
        ):
            raise UpdateRejected("support_coordinate")
        identifier(item[0])
        identifier(item[3])
    return deepcopy(value)


class FeedbackUpdateSession:
    """One bounded adaptation attempt. Transport/evidence binding remain external.

    The generator gets a detached packet after prepare(). The host runs its
    bounded, accounted call, then submits one result. The candidate is never
    active before assess_candidate() accepts the complete comparison. Rollback
    affects policy only and cannot mutate previously committed user memories.
    """

    def __init__(
        self,
        *,
        policy=None,
        interface_id,
        allowed_sources,
        enabled=False,
    ):
        if type(enabled) is not bool:
            raise UpdateRejected("enable_type")
        self._active = policy if policy is not None else PolicySnapshot()
        if type(self._active) is not PolicySnapshot:
            raise UpdateRejected("policy_type")
        self.interface_id = bounded_text(interface_id, 96)
        if (
            type(allowed_sources) not in (tuple, list)
            or not 1 <= len(allowed_sources) <= 8
        ):
            raise UpdateRejected("feedback_authority_configuration")
        self.sources = tuple(identifier(s) for s in allowed_sources)
        self._enabled = enabled
        self._mechanism_id = "verified_single_root_exploration_v1"
        self._parent = self._active
        self._candidate = None
        self._before = None
        self._prepared = None
        self._lock = threading.Lock()
        self._status = "ready" if enabled else "off"
        self._events = []
        self._attempts = 0

    @property
    def active(self):
        return self._active

    @property
    def enabled(self):
        return self._enabled

    @property
    def candidate(self):
        return self._candidate

    def audit(self):
        self._enter()
        try:
            return deepcopy(
                dict(
                    status=self._status,
                    proposal_attempts=self._attempts,
                    maximum_proposals=1,
                    active_policy_sha256=self._active.sha256,
                    events=self._events,
                    mechanism=self._mechanism_id,
                    owns_model_transport=False,
                    owns_memory_store=False,
                    final_effect_proven=False,
                )
            )
        finally:
            self._lock.release()

    def _enter(self):
        if not self._lock.acquire(blocking=False):
            raise UpdateRejected("concurrent_update")

    def _record(self, event, reason=None):
        if len(self._events) >= 8:
            raise UpdateRejected("audit_capacity")
        self._events.append(
            dict(
                ordinal=len(self._events) + 1,
                event=event,
                reason=reason,
                active_policy_sha256=self._active.sha256,
            )
        )

    def _prepare_feedback(self, batch):
        raise NotImplementedError

    def _validate_feedback(self, batch):
        raise NotImplementedError

    def _assess_feedback(self, after):
        raise NotImplementedError

    def prepare(self, batch):
        self._enter()
        try:
            if not self.enabled:
                return dict(eligible=False, reason="off", model_requests=0)
            if self._status != "ready" or self._attempts:
                raise UpdateRejected("adaptation_already_consumed")
            value = self._prepare_feedback(batch)
            if not value["eligible"]:
                self._status = "no_update"
                self._record("no_update", value["reason"])
                return value
            self._before = self._validate_feedback(batch)
            self._prepared = deepcopy(value)
            self._attempts = 1
            self._status = "awaiting_one_proposal"
            self._record("proposal_slot_consumed")
            return deepcopy(value)
        finally:
            self._lock.release()

    def submit(self, packet_sha256, result):
        self._enter()
        try:
            if self._status != "awaiting_one_proposal":
                raise UpdateRejected("no_pending_proposal")
            try:
                if packet_sha256 != self._prepared["packet_sha256"]:
                    raise UpdateRejected("proposal_packet_changed")
                if (
                    type(result) is not dict
                    or set(result) != {"family", "support", "patch"}
                    or len(canonical(result).encode()) > 8192
                ):
                    raise UpdateRejected("proposal_result_contract")
                packet = self._prepared["packet"]
                expected = [
                    [r[k] for k in ("dialogue", "turn", "repeat", "root")]
                    for r in packet["errors"]
                ]
                validate_support(result["support"])
                if (
                    result["family"] != packet["selected_family"]
                    or result["support"] != expected
                ):
                    raise UpdateRejected("proposal_support_changed")
                self._candidate = apply_patch(self._parent, result["patch"])
            except (UpdateRejected, TypeError, ValueError, UnicodeError):
                self._status = "rejected"
                self._record("proposal_rejected", "invalid_proposal")
                raise UpdateRejected("invalid_proposal") from None
            self._status = "awaiting_comparison"
            self._record("candidate_staged_not_active")
            return self._candidate
        finally:
            self._lock.release()

    def evaluate(self, after):
        self._enter()
        try:
            if self._status != "awaiting_comparison":
                raise UpdateRejected("no_pending_comparison")
            try:
                decision = self._assess_feedback(after)
            except (UpdateRejected, TypeError, ValueError, UnicodeError):
                self._status = "rejected"
                self._record("comparison_rejected", "invalid_comparison")
                raise UpdateRejected("invalid_comparison") from None
            if decision["adopt"]:
                self._active = self._candidate
                self._status = "adopted"
                self._record("policy_adopted_on_training")
            else:
                self._status = "rejected"
                self._record("comparison_rejected", "adoption_gate_failed")
            return decision
        finally:
            self._lock.release()

    def cancel(self, reason):
        self._enter()
        try:
            if self._status not in ("awaiting_one_proposal", "awaiting_comparison"):
                raise UpdateRejected("no_pending_adaptation")
            if reason not in ("transport_failure", "evidence_failure", "study_stopped"):
                raise UpdateRejected("cancel_reason")
            self._status = "rejected"
            self._record("adaptation_cancelled", reason)
        finally:
            self._lock.release()

    def rollback(self, reason):
        self._enter()
        try:
            if self._status != "adopted":
                raise UpdateRejected("no_adopted_policy")
            if reason not in ("regression", "operator_request", "load_failure"):
                raise UpdateRejected("rollback_reason")
            self._active = PolicySnapshot.load(self._parent.dump())
            self._status = "rolled_back"
            self._record("policy_rolled_back", reason)
            return self._active
        finally:
            self._lock.release()

    def disable(self):
        self._enter()
        try:
            if not self._enabled:
                return self._active
            self._enabled = False
            self._active = self._parent
            self._status = "off"
            self._record("disabled_restore_initial_policy")
            return self._active
        finally:
            self._lock.release()
