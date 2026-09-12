# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.12,<2", "python-dotenv>=1,<2"]
# ///
"""Run with: uv run agents/test-memory-hooks.py"""
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import memory_hooks
from memory_hooks import capture, flush, recall, redact, resolve_agent_name
from memory_state import open_state, scope, session_options, session_scope, storage_session

defaults = dict(service_id="default", team_id="t", agent_id="a", user_id="u")
options = dict(endpoint="http://127.0.0.1:0", api_key="k", **defaults)
selected = scope(defaults)
other = {**selected, "agent_id": "b"}

db = open_state(":memory:", defaults)
prompt = dict(session_id="s", cwd="/project", hook_event_name="UserPromptSubmit",
              prompt="Remember the coding decision", turn_id="turn1")
stop = dict(session_id="s", hook_event_name="Stop", last_assistant_message="Confirmed decision")
capture(db, prompt, "codex", selected)
capture(db, stop, "codex", selected)
capture(db, stop, "codex", selected)
assert db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 2


def clients(memory, skills):
    """flush builds its own clients, so patch the classes it constructs."""
    memory_cm, skills_cm = patch.object(memory_hooks, "MemoryClient"), patch.object(memory_hooks, "SkillClient")
    memory_cls, skills_cls = memory_cm.start(), skills_cm.start()
    memory_cls.return_value.__enter__.return_value = memory
    skills_cls.return_value.__enter__.return_value = skills
    return lambda: (memory_cm.stop(), skills_cm.stop())


memory, skills = Mock(), Mock()
stop_patching = clients(memory, skills)
memory.add_conversation.side_effect = TimeoutError
try:
    flush(db, options)
except TimeoutError:
    pass
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 2
memory.add_conversation.side_effect = None
flush(db, options)
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 0
skills.conversation_add.assert_called_once()
assert memory.add_conversation.call_args.kwargs["session_id"] == storage_session("codex:s", selected)
assert memory.add_conversation.call_args.kwargs["messages"][0]["content"].startswith("Project: /project")
capture(db, prompt, "claude-code", selected)
capture(db, stop, "claude-code", selected)
assert db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 2

# A turn captured under one agent stays with that agent, and its stored session
# differs from the same conversation under another agent.
capture(db, {**prompt, "session_id": "s2"}, "codex", other)
capture(db, {**stop, "session_id": "s2"}, "codex", selected)
row = db.execute("SELECT payload,scope FROM outbox WHERE sent=0 AND scope LIKE '%\"agent_id\": \"b\"%'").fetchone()
assert row, "the turn must carry the agent it was captured under, not the one passed at Stop"
assert storage_session("codex:s2", other) in row[0]
assert storage_session("codex:s2", other) != storage_session("codex:s2", selected)
flush(db, options)
assert memory.add_conversation.call_args.kwargs["session_id"] == storage_session("codex:s2", other)
stop_patching()

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

# MCP must name a session the hooks already know; it never falls back to a default.
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "hooks.sqlite"
    disk = open_state(path, defaults)
    assert session_scope(disk, "codex:known", defaults) == selected
    disk.close()
    assert scope(session_options("codex:known", path=path)) == selected
    try:
        session_options("codex:unknown", path=path)
    except ValueError:
        pass
    else:
        raise AssertionError("unknown session must not resolve to a default agent")

# mem:agent accepts a name; ambiguity is refused rather than guessed.
meta = Mock()
meta.list_agents.return_value = {"items": [
    {"agent_id": "agt-1", "team_id": "t", "name": "Code Reviewer"},
    {"agent_id": "agt-2", "team_id": "t", "name": "Data Engineer"},
    {"agent_id": "agt-3", "team_id": "elsewhere", "name": "Code Reviewer"},
]}
assert resolve_agent_name(meta, "t", "Code Reviewer") == "agt-1"
assert resolve_agent_name(meta, "t", "code reviewer") == "agt-1"
try:
    resolve_agent_name(meta, "t", "No Such Agent")
except ValueError as exc:
    assert "Code Reviewer" in str(exc) and "Data Engineer" in str(exc)
else:
    raise AssertionError("an unknown name must list the available ones")
meta.list_agents.return_value = {"items": [
    {"agent_id": "agt-1", "team_id": "t", "name": "Twin"},
    {"agent_id": "agt-2", "team_id": "t", "name": "Twin"},
]}
try:
    resolve_agent_name(meta, "t", "Twin")
except ValueError as exc:
    assert "ambiguous" in str(exc)
else:
    raise AssertionError("an ambiguous name must be refused, not guessed")

print("PASS: capture, replay, per-conversation scope, recall, redaction, session pinning, name resolution")
