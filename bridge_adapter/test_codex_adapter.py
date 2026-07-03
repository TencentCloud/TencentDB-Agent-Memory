"""Tests for CodexAdapter 鈥?uses mock subprocess to avoid Codex CLI dependency."""

import json
from unittest.mock import patch, MagicMock

from bridge_adapter.codex_adapter import CodexAdapter


def _mock_subprocess(stdout: str = "", stderr: str = "", returncode: int = 0):
    """Create a mock subprocess.run result."""
    m = MagicMock()
    m.stdout = stdout
    m.stderr = stderr
    m.returncode = returncode
    return m


def test_name():
    adapter = CodexAdapter()
    assert adapter.name == "codex"


def test_initialize_sets_available():
    adapter = CodexAdapter()
    with patch("subprocess.run", return_value=_mock_subprocess(stdout="Codex CLI 0.137.0")):
        adapter.initialize(codex_path="codex")
        assert adapter.is_available() is True


def test_initialize_sets_unavailable_on_failure():
    adapter = CodexAdapter()
    with patch("subprocess.run", side_effect=FileNotFoundError):
        adapter.initialize(codex_path="codex")
        assert adapter.is_available() is False


def test_recall_returns_empty_on_mcp_failure():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    with patch("subprocess.run", return_value=_mock_subprocess(returncode=1)):
        result = adapter._recall_impl("test query", 5)
    assert result == {"prepend_context": "", "append_system_context": ""}


def test_recall_returns_result():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    stub_output = "Memory entry 1\nMemory entry 2\n"
    with patch("subprocess.run", return_value=_mock_subprocess(stdout=stub_output)):
        result = adapter._recall_impl("test query", 5)
    assert result["prepend_context"] == stub_output.strip()
    assert result["append_system_context"] == ""


def test_capture_returns_true_on_success():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    with patch("subprocess.run", return_value=_mock_subprocess(stdout="ok")):
        result = adapter._capture_impl("user msg", "assistant msg", "sess-1")
    assert result is True


def test_capture_returns_false_on_failure():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    with patch("subprocess.run", return_value=_mock_subprocess(returncode=1)):
        result = adapter._capture_impl("user msg", "assistant msg", "sess-1")
    assert result is False


def test_search_memory_returns_list():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    stub = "result A\nresult B\nresult C\n"
    with patch("subprocess.run", return_value=_mock_subprocess(stdout=stub)):
        results = adapter._search_memory_impl("query", 3)
    assert len(results) == 3
    assert results[0]["source"] == "codex"


def test_search_conversation_returns_filtered():
    adapter = CodexAdapter()
    adapter._available = True
    adapter._codex_path = "codex"
    stub = "turn about python\nanother turn about rust\ndifferent topic\n"
    with patch("subprocess.run", return_value=_mock_subprocess(stdout=stub)):
        results = adapter._search_conversation_impl("python", 5)
    assert len(results) >= 1
    assert "python" in results[0]["content"]


def test_shutdown_resets_available():
    adapter = CodexAdapter()
    adapter._available = True
    adapter.shutdown()
    assert adapter.is_available() is False


def test_recall_via_public_api_graceful_degradation():
    """Public recall() handles subprocess failure gracefully via TdaiAdapter guards."""
    adapter = CodexAdapter()
    adapter._codex_path = "codex"
    with patch("subprocess.run", return_value=_mock_subprocess(returncode=1)):
        # Initialize marks as available because our mock returns version
        # Then recall is called and mcp_call returns None due to tool failure
        result = adapter.recall("test", limit=5)
    assert "prepend_context" in result
    assert result["prepend_context"] == ""
