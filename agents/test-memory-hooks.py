# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.12,<2", "python-dotenv>=1,<2"]
# ///
"""Run with: uv run agents/test-memory-hooks.py"""
import json
from unittest.mock import Mock

from memory_hooks import capture, flush, open_state, recall, redact

db = open_state(":memory:")
memory, skills = Mock(), Mock()
isolation = dict(team_id="t", agent_id="a", user_id="u")
prompt = dict(session_id="s", cwd="/project", hook_event_name="UserPromptSubmit",
              prompt="Remember the coding decision", turn_id="turn1")
stop = dict(session_id="s", hook_event_name="Stop", last_assistant_message="Confirmed decision")
capture(db, prompt, "codex")
capture(db, stop, "codex")
capture(db, stop, "codex")
assert db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 2
memory.add_conversation.side_effect = TimeoutError
try:
    flush(db, memory, skills, isolation)
except TimeoutError:
    pass
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 2
memory.add_conversation.side_effect = None
flush(db, memory, skills, isolation)
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 0
skills.conversation_add.assert_called_once()
assert memory.add_conversation.call_args.kwargs["session_id"] == "codex:s"
assert memory.add_conversation.call_args.kwargs["messages"][0]["content"].startswith("Project: /project")
capture(db, prompt, "claude-code")
capture(db, stop, "claude-code")
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 2
for method in ("read_core", "list_scenarios", "search_atomic", "search_conversation"):
    getattr(memory, method).return_value = {"content": "remembered decision"}
skills.search.return_value = {"items": []}
result = recall(prompt, memory, skills)
assert result["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
assert "remembered decision" in result["hookSpecificOutput"]["additionalContext"]
secret = "sk-" + "x" * 32
assert secret not in redact(secret)
assert "hunter2" not in redact("password=hunter2")
db.close()
print("PASS: automatic capture, replay, source isolation, recall injection, and redaction")
