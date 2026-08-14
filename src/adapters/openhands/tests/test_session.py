from tdai_openhands.session import hook_session_key


def test_hook_session_key_uses_prefix_and_slugged_session_id() -> None:
    assert hook_session_key("openhands/tui", "Conversation ID 123") == (
        "openhands/tui/Conversation-ID-123"
    )


def test_hook_session_key_normalizes_trailing_separator() -> None:
    assert hook_session_key("openhands/tui/", "abc") == "openhands/tui/abc"
