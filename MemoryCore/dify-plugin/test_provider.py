"""Tests for the Dify adapter (MemoryTencentdbDifyProvider).

These tests focus on the 4 abstract methods that are platform-specific:
- format_recall_result
- get_tool_definitions
- format_tool_result
- normalize_messages

They do NOT require a running Gateway — they test only the formatting
and normalization logic unique to the Dify platform adapter.

Run with::

    cd MemoryCore/dify-plugin
    python -m pytest test_provider.py -v
"""

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

# Add the plugin directory to sys.path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "memory_tencentdb_dify"))

from memory_tencentdb_dify.provider import (
    MemoryTencentdbDifyProvider,
    build_adapter_config_from_env,
    build_adapter_config_from_credentials,
    MEMORY_SEARCH_TOOL_YAML,
    CONVERSATION_SEARCH_TOOL_YAML,
    READ_SCENE_TOOL_YAML,
)
from memory_tencentdb_dify.types import (
    RecallResult,
    SearchResult,
    MemoryItem,
    PersonaContent,
    SceneEntry,
    ConversationMessage,
)


# ── Helpers ────────────────────────────────────────────────────────


def make_recall_result(**overrides: Any) -> RecallResult:
    """Build a RecallResult with defaults, allowing overrides."""
    base: Dict[str, Any] = {
        "prepend_context": "",
        "append_system_context": "",
        "memories": [],
        "persona": None,
        "scenes": [],
        "latency_ms": 42,
    }
    base.update(overrides)
    return RecallResult(**base)


SAMPLE_MEMORIES: List[MemoryItem] = [
    MemoryItem(type="persona", content="Prefers dark mode", score=0.952),
    MemoryItem(type="episodic", content="Discussed React state management", score=0.871),
    MemoryItem(type="instruction", content="Always use functional components", score=0.763),
]

SAMPLE_PERSONA = PersonaContent(
    content="Alice is a senior frontend developer who values clean code.",
    updated_at="2024-03-15T10:00:00Z",
)

SAMPLE_SCENES: List[SceneEntry] = [
    SceneEntry(path="scene_blocks/travel-plan.md", summary="Summer vacation planning", heat=3),
    SceneEntry(path="scene_blocks/project-setup.md", summary="React project initialization"),
]


# ── Tests ──────────────────────────────────────────────────────────


class TestPlatformName:
    """Tests for platform_name."""

    def test_platform_name(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        assert adapter.platform_name == "dify"


class TestFormatRecallResult:
    """Tests for format_recall_result."""

    def test_memories_in_prepend_context(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(
            make_recall_result(memories=SAMPLE_MEMORIES)
        )

        assert result["prepend_context"]
        assert "<relevant-memories>" in result["prepend_context"]
        assert "</relevant-memories>" in result["prepend_context"]
        assert "[persona]" in result["prepend_context"]
        assert "Prefers dark mode" in result["prepend_context"]
        assert "[episodic]" in result["prepend_context"]
        assert "[instruction]" in result["prepend_context"]

    def test_persona_in_append_context(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(
            make_recall_result(persona=SAMPLE_PERSONA)
        )

        assert result["append_system_context"]
        assert "<user-core>" in result["append_system_context"]
        assert "Alice is a senior frontend developer" in result["append_system_context"]

    def test_scenes_in_append_context(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(
            make_recall_result(scenes=SAMPLE_SCENES)
        )

        assert result["append_system_context"]
        assert "<scene-navigation>" in result["append_system_context"]
        assert "travel-plan" in result["append_system_context"]
        assert "Summer vacation planning" in result["append_system_context"]

    def test_empty_result(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(make_recall_result())

        assert result["prepend_context"] == ""
        assert result["append_system_context"] == ""

    def test_memory_without_score(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(
            make_recall_result(
                memories=[MemoryItem(type="episodic", content="No score")]
            )
        )

        assert "No score" in result["prepend_context"]
        assert "score:" not in result["prepend_context"]

    def test_combined_persona_and_scenes(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        result = adapter.format_recall_result(
            make_recall_result(persona=SAMPLE_PERSONA, scenes=SAMPLE_SCENES)
        )

        assert "<user-core>" in result["append_system_context"]
        assert "<scene-navigation>" in result["append_system_context"]
        # Persona should come before scenes
        persona_idx = result["append_system_context"].index("<user-core>")
        scene_idx = result["append_system_context"].index("<scene-navigation>")
        assert persona_idx < scene_idx


class TestGetToolDefinitions:
    """Tests for get_tool_definitions."""

    def test_returns_list(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        tools = adapter.get_tool_definitions()
        assert isinstance(tools, list)
        assert len(tools) >= 3

    def test_includes_memory_search_tool(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        tools = adapter.get_tool_definitions()
        names = [t["name"] if isinstance(t, dict) else t.name for t in tools]
        assert "memory_tencentdb_memory_search" in names or "tdai_memory_search" in names or "memory_search" in names

    def test_includes_conversation_search_tool(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        tools = adapter.get_tool_definitions()
        names = [t["name"] if isinstance(t, dict) else t.name for t in tools]
        assert "memory_tencentdb_conversation_search" in names or "tdai_conversation_search" in names or "conversation_search" in names

    def test_includes_read_scene_tool(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        tools = adapter.get_tool_definitions()
        names = [t["name"] if isinstance(t, dict) else t.name for t in tools]
        assert "memory_tencentdb_read_scene" in names or "tdai_read_scene" in names or "read_scene" in names


class TestFormatToolResult:
    """Tests for format_tool_result."""

    def test_memory_search_results(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        search_result = SearchResult(
            text="",
            total=2,
            items=SAMPLE_MEMORIES[:2],
        )
        formatted = adapter.format_tool_result("tdai_memory_search", search_result)
        assert "[persona]" in formatted
        assert "Prefers dark mode" in formatted

    def test_empty_search(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        search_result = SearchResult(text="", total=0, items=[])
        formatted = adapter.format_tool_result("tdai_memory_search", search_result)
        assert "No" in formatted or "no" in formatted

    def test_string_result_passes_through(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        scene_content = "# Travel Plan\n\nDestination: Japan"
        formatted = adapter.format_tool_result("tdai_read_scene", scene_content)
        assert formatted == scene_content

    def test_conversation_search_results(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        search_result = SearchResult(
            text="",
            total=1,
            items=[MemoryItem(type="conversation", content="User said hello", score=0.85)],
        )
        formatted = adapter.format_tool_result("tdai_conversation_search", search_result)
        assert "User said hello" in formatted


class TestNormalizeMessages:
    """Tests for normalize_messages."""

    def test_query_answer_format(self) -> None:
        """Dify's {query, answer} pair format."""
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages([
            {"query": "What is React?", "answer": "React is a JS library."},
        ])

        assert len(messages) == 2
        assert messages[0].role == "user"
        assert messages[0].content == "What is React?"
        assert messages[1].role == "assistant"
        assert messages[1].content == "React is a JS library."

    def test_role_content_format(self) -> None:
        """Standard {role, content} format."""
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages([
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ])

        assert len(messages) == 2
        assert messages[0].role == "user"
        assert messages[0].content == "Hello"
        assert messages[1].role == "assistant"
        assert messages[1].content == "Hi there"

    def test_plain_string_input(self) -> None:
        """Plain string input."""
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages("Just a plain string message")

        assert len(messages) >= 1

    def test_empty_list(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        assert adapter.normalize_messages([]) == []

    def test_none_input(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        assert adapter.normalize_messages(None) == []

    def test_non_list_input(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        assert adapter.normalize_messages(42) == []
        assert adapter.normalize_messages({"key": "value"}) == []

    def test_skips_empty_content(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages([
            {"role": "user", "content": ""},
            {"role": "assistant", "content": "Valid"},
        ])

        assert len(messages) == 1
        assert messages[0].content == "Valid"

    def test_adds_timestamp(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages([
            {"role": "user", "content": "Hello"},
        ])

        assert messages[0].timestamp is not None
        # Handle Python 3.10's fromisoformat not supporting 'Z' suffix
        ts = messages[0].timestamp
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        datetime.fromisoformat(ts)

    def test_preserves_timestamp(self) -> None:
        adapter = MemoryTencentdbDifyProvider()
        messages = adapter.normalize_messages([
            {"role": "user", "content": "Hello", "timestamp": "2024-01-15T10:00:00Z"},
        ])

        assert messages[0].timestamp == "2024-01-15T10:00:00Z"


class TestConfigFromEnv:
    """Tests for build_adapter_config_from_env."""

    def test_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            # Clear all TDAI_ vars
            for key in list(os.environ.keys()):
                if key.startswith("TDAI_"):
                    del os.environ[key]

            config = build_adapter_config_from_env()

            assert config["gateway"]["endpoint"] == "http://127.0.0.1:8420"
            assert config["gateway"]["service_id"] == "default"
            assert config["gateway"]["timeout_ms"] == 10_000
            assert config["tenancy"]["team_id"] == "default"
            assert config["recall_max_results"] == 5
            assert config["recall_include_persona"] is True
            assert config["recall_include_scene_nav"] is True
            assert config["capture_enabled"] is True

    def test_env_overrides(self) -> None:
        env_overrides = {
            "TDAI_GATEWAY_ENDPOINT": "http://custom:9999",
            "TDAI_GATEWAY_API_KEY": "secret-key",
            "TDAI_GATEWAY_SERVICE_ID": "my-service",
            "TDAI_GATEWAY_TIMEOUT_MS": "5000",
            "TDAI_TEAM_ID": "my-team",
            "TDAI_AGENT_ID": "my-agent",
            "TDAI_USER_ID": "alice",
            "TDAI_RECALL_MAX_RESULTS": "10",
            "TDAI_RECALL_INCLUDE_PERSONA": "false",
            "TDAI_RECALL_INCLUDE_SCENE_NAV": "false",
            "TDAI_CAPTURE_ENABLED": "false",
        }
        with patch.dict(os.environ, env_overrides, clear=False):
            config = build_adapter_config_from_env()

            assert config["gateway"]["endpoint"] == "http://custom:9999"
            assert config["gateway"]["api_key"] == "secret-key"
            assert config["gateway"]["service_id"] == "my-service"
            assert config["gateway"]["timeout_ms"] == 5000
            assert config["tenancy"]["team_id"] == "my-team"
            assert config["tenancy"]["agent_id"] == "my-agent"
            assert config["tenancy"]["user_id"] == "alice"
            assert config["recall_max_results"] == 10
            assert config["recall_include_persona"] is False
            assert config["recall_include_scene_nav"] is False
            assert config["capture_enabled"] is False

    def test_invalid_int_falls_back_to_default(self) -> None:
        with patch.dict(os.environ, {"TDAI_GATEWAY_TIMEOUT_MS": "not-a-number"}):
            config = build_adapter_config_from_env()
            assert config["gateway"]["timeout_ms"] == 10_000


class TestConfigFromCredentials:
    """Tests for build_adapter_config_from_credentials."""

    def test_credentials_override_env(self) -> None:
        with patch.dict(os.environ, {"TDAI_GATEWAY_ENDPOINT": "http://env:8420"}):
            config = build_adapter_config_from_credentials({
                "gateway_endpoint": "http://cred:9999",
                "gateway_api_key": "cred-key",
                "team_id": "cred-team",
                "user_id": "cred-user",
            })

            assert config["gateway"]["endpoint"] == "http://cred:9999"
            assert config["gateway"]["api_key"] == "cred-key"
            assert config["tenancy"]["team_id"] == "cred-team"
            assert config["tenancy"]["user_id"] == "cred-user"

    def test_empty_credentials_falls_back_to_env(self) -> None:
        with patch.dict(os.environ, {"TDAI_GATEWAY_ENDPOINT": "http://env:8420"}):
            config = build_adapter_config_from_credentials({})

            assert config["gateway"]["endpoint"] == "http://env:8420"

    def test_partial_credentials(self) -> None:
        with patch.dict(os.environ, {"TDAI_TEAM_ID": "env-team"}):
            config = build_adapter_config_from_credentials({
                "gateway_endpoint": "http://cred:9999",
            })

            assert config["gateway"]["endpoint"] == "http://cred:9999"
            assert config["tenancy"]["team_id"] == "env-team"


class TestToolYamlSchemas:
    """Tests for the Dify tool YAML schema constants."""

    def test_memory_search_tool_yaml(self) -> None:
        assert MEMORY_SEARCH_TOOL_YAML["identity"]["name"] == "memory_search"
        assert "parameters" in MEMORY_SEARCH_TOOL_YAML
        params = MEMORY_SEARCH_TOOL_YAML["parameters"]
        param_names = [p["name"] for p in params]
        assert "query" in param_names
        assert "limit" in param_names

    def test_conversation_search_tool_yaml(self) -> None:
        assert CONVERSATION_SEARCH_TOOL_YAML["identity"]["name"] == "conversation_search"
        params = CONVERSATION_SEARCH_TOOL_YAML["parameters"]
        param_names = [p["name"] for p in params]
        assert "query" in param_names
        assert "session_key" in param_names

    def test_read_scene_tool_yaml(self) -> None:
        assert READ_SCENE_TOOL_YAML["identity"]["name"] == "read_scene"
        params = READ_SCENE_TOOL_YAML["parameters"]
        param_names = [p["name"] for p in params]
        assert "scene_id" in param_names

    def test_yaml_has_bilingual_labels(self) -> None:
        for yaml_schema in [MEMORY_SEARCH_TOOL_YAML, CONVERSATION_SEARCH_TOOL_YAML, READ_SCENE_TOOL_YAML]:
            label = yaml_schema["identity"]["label"]
            assert "en_US" in label
            assert "zh_Hans" in label


class TestCircuitBreaker:
    """Tests for circuit breaker constants."""

    def test_breaker_threshold(self) -> None:
        from memory_tencentdb_dify.base_adapter import BREAKER_THRESHOLD
        assert BREAKER_THRESHOLD == 5

    def test_breaker_cooldown(self) -> None:
        from memory_tencentdb_dify.base_adapter import BREAKER_COOLDOWN_MS
        assert BREAKER_COOLDOWN_MS == 60_000


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
