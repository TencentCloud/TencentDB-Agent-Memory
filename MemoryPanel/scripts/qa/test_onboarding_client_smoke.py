"""Regression for L0 readback from the current onboarding run."""

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("onboarding-client-smoke.py")
spec = importlib.util.spec_from_file_location("onboarding_client_smoke", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
model_spec = importlib.util.spec_from_file_location(
    "onboarding_fake_model", Path(__file__).with_name("onboarding-fake-model.py")
)
model = importlib.util.module_from_spec(model_spec)
model_spec.loader.exec_module(model)


class CurrentTurnTests(unittest.TestCase):
    def test_matching_text_from_different_sessions_is_rejected(self):
        self.assertFalse(smoke.has_current_turns([
            {"role": "user", "title": "user @ session-a", "body": "current-user"},
            {"role": "assistant", "title": "assistant @ session-b", "body": "current-reply"},
        ], "current-user", "current-reply", "current"))

    def test_wrong_roles_are_rejected(self):
        self.assertFalse(smoke.has_current_turns([
            {"role": "assistant", "title": "assistant @ current", "body": "current-user"},
            {"role": "user", "title": "user @ current", "body": "current-reply"},
        ], "current-user", "current-reply", "current"))

    def test_missing_session_is_rejected(self):
        self.assertFalse(smoke.has_current_turns([
            {"role": "user", "body": "current-user"},
            {"role": "assistant", "body": "current-reply"},
        ], "current-user", "current-reply", "current"))

    def test_missing_either_turn_is_rejected(self):
        for role, body in (("user", "current-user"), ("assistant", "current-reply")):
            with self.subTest(role=role):
                self.assertFalse(smoke.has_current_turns([
                    {"role": role, "title": f"{role} @ current", "body": body},
                ], "current-user", "current-reply", "current"))

    def test_prior_session_with_matching_text_is_rejected(self):
        items = [
            {"role": "user", "title": "user @ prior", "body": "current-user"},
            {"role": "assistant", "title": "assistant @ prior", "body": "current-reply"},
        ]
        self.assertFalse(smoke.has_current_turns(items, "current-user", "current-reply", "current"))
        self.assertFalse(smoke.has_current_turns(items, "current-user", "current-reply", ""))

    def test_fake_model_reply_uses_current_user_turn(self):
        first = model.assistant_reply({"messages": [{"role": "user", "content": "run-one"}]})
        second = model.assistant_reply({"messages": [{"role": "user", "content": "run-two"}]})
        self.assertEqual(first, "Onboarding fake model response: run-one")
        self.assertEqual(second, "Onboarding fake model response: run-two")

    def test_prior_assistant_turn_cannot_confirm_new_run(self):
        items = [
            {"role": "user", "title": "user @ current", "body": "ON05 onboarding smoke new-run"},
            {"body": "Onboarding fake model response: ON05 onboarding smoke old-run"},
        ]
        self.assertFalse(smoke.has_current_turns(
            items,
            "ON05 onboarding smoke new-run",
            "Onboarding fake model response: ON05 onboarding smoke new-run",
            "current",
        ))

    def test_matching_turns_confirm_new_run(self):
        items = [
            {"role": "user", "title": "user @ current", "body": "ON05 onboarding smoke new-run"},
            {"role": "assistant", "title": "assistant @ current", "body": "Onboarding fake model response: ON05 onboarding smoke new-run"},
        ]
        self.assertTrue(smoke.has_current_turns(
            items,
            "ON05 onboarding smoke new-run",
            "Onboarding fake model response: ON05 onboarding smoke new-run",
            "current",
        ))


if __name__ == "__main__":
    unittest.main()
