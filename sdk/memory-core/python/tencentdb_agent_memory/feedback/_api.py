"""Optional one-shot adaptation API over host-verified source-bound feedback."""

from copy import deepcopy
from threading import Lock
from typing import Any, Dict, List, Optional, Tuple, Union

from ._single import SingleFeedbackExplorationSession
from ._core import PolicySnapshot, UpdateRejected, bounded_text, canonical
from ._instruction import GENERATOR_SYSTEM
from ._proposal import parse_proposal

StringList = Union[List[str], Tuple[str, ...]]


class FeedbackOptimizer:
    """One update attempt, disabled by default, with caller-owned model and store.

    The host must verify annotations and physical trace references before prepare.
    This object enforces consistency, bounds, selection and training adoption.
    It neither proves label truth nor measures independent future-task benefit.
    """

    def __init__(
        self,
        *,
        interface_id: str,
        allowed_sources: StringList,
        excluded_literals: StringList,
        policy: Optional[PolicySnapshot] = None,
        enabled: bool = False,
    ) -> None:
        if type(excluded_literals) not in (tuple, list) or len(excluded_literals) > 128:
            raise UpdateRejected("excluded_literals_capacity")
        self._excluded = tuple(bounded_text(s, 128) for s in excluded_literals)
        self._session = SingleFeedbackExplorationSession(
            policy=policy,
            interface_id=interface_id,
            allowed_sources=allowed_sources,
            enabled=enabled,
        )
        self._prepared: Optional[Dict[str, Any]] = None
        self._request_count = 0
        self._response_audit: Optional[Dict[str, Any]] = None
        self._lock = Lock()

    def _enter(self) -> None:
        if not self._lock.acquire(blocking=False):
            raise UpdateRejected("concurrent_update")

    @property
    def active(self) -> PolicySnapshot:
        return self._session.active

    @property
    def candidate(self) -> Optional[PolicySnapshot]:
        return self._session.candidate

    @property
    def enabled(self) -> bool:
        return self._session.enabled

    def prepare(self, batch: Dict[str, Any]) -> Dict[str, Any]:
        """Filter a detached feedback batch; off mode does not inspect the batch."""
        self._enter()
        try:
            result = self._session.prepare(batch)
            self._prepared = deepcopy(result) if result["eligible"] else None
            return result
        finally:
            self._lock.release()

    def generation_request(self, classifier_system: str) -> Dict[str, Any]:
        """Build at most one provider-neutral request with the frozen classifier.

        This method performs no model call. The host owns timeouts, send budgets,
        raw-response evidence and the equivalence of classifier_system to its
        registered interface_id.
        """
        self._enter()
        try:
            if (
                self._prepared is None
                or self._session.audit()["status"] != "awaiting_one_proposal"
                or self._request_count
            ):
                raise UpdateRejected("no_pending_generation_request")
            self._request_count = 1
            try:
                bounded_text(classifier_system, 32768)
                value = {
                    **self._prepared["packet"],
                    "classifier_component": {
                        "exact_system": classifier_system,
                        "operation": "one rule patch; all public interfaces and guards immutable",
                    },
                }
                prompt = canonical(value)
                if len((GENERATOR_SYSTEM + prompt).encode("utf-8")) > 32768:
                    raise UpdateRejected("generation_context_capacity")
                return {
                    "system_prompt": GENERATOR_SYSTEM,
                    "messages": [{"role": "user", "content": prompt}],
                }
            except (ValueError, TypeError, UnicodeError):
                self._session.cancel("evidence_failure")
                raise UpdateRejected("invalid_generation_request") from None
        finally:
            self._lock.release()

    def submit_response(self, packet_sha256: str, raw_response: str) -> PolicySnapshot:
        """Parse one bounded response and stage an inactive candidate.

        A malformed response consumes the pending opportunity. The host must
        cancel on transport failure instead of obtaining another model response.
        """
        self._enter()
        try:
            if (
                self._request_count != 1
                or self._session.audit()["status"] != "awaiting_one_proposal"
            ):
                raise UpdateRejected("no_pending_proposal")
            try:
                result, audit = parse_proposal(raw_response, self._excluded)
                candidate = self._session.submit(packet_sha256, result)
                self._response_audit = audit
                return candidate
            except (ValueError, TypeError, UnicodeError, RecursionError):
                if self._session.audit()["status"] == "awaiting_one_proposal":
                    self._session.cancel("evidence_failure")
                raise UpdateRejected("invalid_proposal") from None
        finally:
            self._lock.release()

    def evaluate(self, comparison: Dict[str, Any]) -> Dict[str, Any]:
        """Adopt only after a complete, protected actual-outcome comparison."""
        self._enter()
        try:
            return self._session.evaluate(comparison)
        finally:
            self._lock.release()

    def cancel(self, reason: str) -> None:
        self._enter()
        try:
            self._session.cancel(reason)
        finally:
            self._lock.release()

    def rollback(self, reason: str) -> PolicySnapshot:
        self._enter()
        try:
            return self._session.rollback(reason)
        finally:
            self._lock.release()

    def disable(self) -> PolicySnapshot:
        self._enter()
        try:
            return self._session.disable()
        finally:
            self._lock.release()

    def audit(self) -> Dict[str, Any]:
        """Detached, bounded metadata; no feedback text or raw model response."""
        self._enter()
        try:
            return {
                **self._session.audit(),
                "generation_requests_built": self._request_count,
                "response_surface": deepcopy(self._response_audit),
            }
        finally:
            self._lock.release()
