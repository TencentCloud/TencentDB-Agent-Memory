import unittest

from memory_tencentdb_pydantic_ai.identity import MemoryIdentity


class MemoryIdentityTests(unittest.TestCase):
    def test_default_session_key_is_deterministic_and_escaped(self) -> None:
        identity = MemoryIdentity.create("user:一", "session/1")

        self.assertEqual(
            identity.session_key,
            "pydantic-ai:user%3A%E4%B8%80:session%2F1",
        )

    def test_explicit_session_key_is_preserved(self) -> None:
        identity = MemoryIdentity.create("u", "s", session_key="legacy:key")

        self.assertEqual(identity.session_key, "legacy:key")

    def test_empty_user_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "user_id"):
            MemoryIdentity.create(" ", "s")

    def test_empty_session_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "session_id"):
            MemoryIdentity.create("u", "")

    def test_empty_explicit_session_key_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "session_key"):
            MemoryIdentity.create("u", "s", session_key=" ")


if __name__ == "__main__":
    unittest.main()
