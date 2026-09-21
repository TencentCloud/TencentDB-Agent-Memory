"""Public-API engineering checks; synthetic inputs, zero model requests."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

from tencentdb_agent_memory.feedback import (
    FeedbackOptimizer,
    FeedbackRejected,
    PolicySnapshot,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from _feedback_fixture import (
    AUTHORITY,
    INTERFACE,
    feedback_fixture,
    scripted_proposal,
    synthetic_comparison,
)


def optimizer(**kwargs):
    kwargs.setdefault("excluded_literals", ("D1", "D2", "D3"))
    return FeedbackOptimizer(
        interface_id=INTERFACE, allowed_sources=AUTHORITY, enabled=True, **kwargs
    )


def stage(instance, before):
    prepared = instance.prepare(before)
    instance.generation_request("Fixed synthetic classifier contract.")
    candidate = instance.submit_response(
        prepared["packet_sha256"], json.dumps(scripted_proposal(prepared))
    )
    return prepared, candidate


class FeedbackApiTests(unittest.TestCase):
    def test_default_off_and_existing_sdk_exports_are_unchanged(self):
        import tencentdb_agent_memory as sdk
        from tencentdb_agent_memory.v2 import MemoryClient, AsyncMemoryClient

        self.assertIs(sdk.MemoryClient, MemoryClient)
        self.assertIs(sdk.AsyncMemoryClient, AsyncMemoryClient)
        instance = FeedbackOptimizer(
            interface_id=INTERFACE, allowed_sources=AUTHORITY, excluded_literals=()
        )
        self.assertEqual(
            instance.prepare(None), dict(eligible=False, reason="off", model_requests=0)
        )
        with self.assertRaises(FeedbackRejected):
            instance.generation_request("unused")
        self.assertEqual(instance.audit()["generation_requests_built"], 0)
        self.assertFalse(
            any(n == "rdagent" or n.startswith("rdagent.") for n in sys.modules)
        )

    def test_actual_comparison_controls_adoption_load_and_rollback(self):
        for improved in (False, True):
            instance = optimizer()
            before = feedback_fixture()
            _, candidate = stage(instance, before)
            self.assertEqual(instance.active, PolicySnapshot())
            decision = instance.evaluate(
                synthetic_comparison(before, candidate, state_improved=improved)
            )
            self.assertEqual(decision["adopt"], improved)
            self.assertFalse(decision["final_effect_proven"])
            if improved:
                self.assertEqual(PolicySnapshot.load(instance.active.dump()), candidate)
                self.assertEqual(
                    instance.rollback("operator_request"), PolicySnapshot()
                )
            self.assertEqual(instance.disable(), PolicySnapshot())

    def test_untrusted_and_incomplete_records_cannot_be_adopted(self):
        before = feedback_fixture()
        before["rows"][0]["authority"] = "model_confidence"
        with self.assertRaises(FeedbackRejected):
            optimizer().prepare(before)
        before = feedback_fixture()
        row = before["rows"][-1]
        row.update(observed=False, cause="infrastructure", predicted=None)
        row["checks"] = {k: None for k in row["checks"]}
        row["risks"] = {k: None for k in row["risks"]}
        instance = optimizer()
        _, candidate = stage(instance, before)
        after = synthetic_comparison(before, candidate)
        row = after["rows"][-1]
        row.update(observed=False, cause="infrastructure", predicted=None)
        row["checks"] = {k: None for k in row["checks"]}
        row["risks"] = {k: None for k in row["risks"]}
        decision = instance.evaluate(after)
        self.assertEqual(decision["reasons"], ["comparison_measurements_missing"])
        self.assertFalse(decision["adopt"])
        self.assertEqual(instance.active, PolicySnapshot())

    def test_prepared_packet_is_detached_and_generation_has_a_hard_limit(self):
        instance = optimizer()
        before = feedback_fixture()
        prepared = instance.prepare(before)
        original = deepcopy(prepared)
        prepared["packet"]["errors"].clear()
        request = instance.generation_request("Registered fixed classifier text.")
        payload = json.loads(request["messages"][0]["content"])
        self.assertEqual(payload["errors"], original["packet"]["errors"])
        self.assertEqual(
            payload["classifier_component"]["exact_system"],
            "Registered fixed classifier text.",
        )
        with self.assertRaises(FeedbackRejected):
            instance.generation_request("second request")
        instance.cancel("transport_failure")
        oversized = optimizer()
        oversized.prepare(before)
        with self.assertRaises(FeedbackRejected):
            oversized.generation_request("x" * 32768)
        self.assertEqual(oversized.audit()["status"], "rejected")

    def test_malformed_copied_or_misbound_response_consumes_one_opportunity(self):
        for invalid in (
            "malformed",
            "duplicate_key",
            "copied_literal",
            "wrong_packet",
            "wrong_support",
        ):
            instance = optimizer(excluded_literals=("ForbiddenTrainingValue",))
            prepared = instance.prepare(feedback_fixture())
            instance.generation_request("Fixed classifier")
            response = scripted_proposal(prepared)
            token = prepared["packet_sha256"]
            if invalid == "copied_literal":
                response["patch"]["text"] = "Use ForbiddenTrainingValue forever."
            if invalid == "wrong_support":
                response["support"][0][1] = True
            if invalid == "wrong_packet":
                token = "0" * 64
            raw = json.dumps(response)
            if invalid == "malformed":
                raw = "not JSON"
            if invalid == "duplicate_key":
                raw = raw[:-1] + ', "patch": {}}'
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(FeedbackRejected, "invalid_proposal"),
            ):
                instance.submit_response(token, raw)
            self.assertEqual(instance.active, PolicySnapshot())
            with self.assertRaisesRegex(FeedbackRejected, "no_pending_proposal"):
                instance.submit_response(
                    prepared["packet_sha256"], json.dumps(scripted_proposal(prepared))
                )

    def test_one_exact_fence_with_exact_support_does_not_repair_semantics(self):
        instance = optimizer()
        prepared = instance.prepare(feedback_fixture())
        instance.generation_request("Fixed classifier")
        raw = "```json\n" + json.dumps(scripted_proposal(prepared)) + "\n```"
        candidate = instance.submit_response(prepared["packet_sha256"], raw)
        audit = instance.audit()
        self.assertFalse(audit["response_surface"]["semantic_repair"])
        self.assertEqual(
            audit["response_surface"]["support_transformation"],
            "none",
        )
        self.assertEqual(candidate.version, 1)
        self.assertEqual(instance.active.version, 0)
        audit["events"].clear()
        self.assertTrue(instance.audit()["events"])
        with self.assertRaises(FeedbackRejected):
            instance.submit_response(prepared["packet_sha256"], raw)


if __name__ == "__main__":
    unittest.main()
