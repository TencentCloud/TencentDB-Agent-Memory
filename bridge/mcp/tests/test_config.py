"""Tests for MCP server configuration 鈥?env-var fallback chain and dual-path setup."""

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# 鈹€鈹€ API Key resolution 鈹€鈹€

def test_mcp_api_key_fallback_to_tdai():
    """When MCP_BRIDGE_API_KEY is not set, TDAI_API_KEY should be used."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["TDAI_API_KEY"] = "tdai-key-value"
        import importlib
        import bridge.mcp.server as srv
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "tdai-key-value"

def test_mcp_api_key_override():
    """MCP_BRIDGE_API_KEY should take precedence over TDAI_API_KEY."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["MCP_BRIDGE_API_KEY"] = "mcp-specific-key"
        os.environ["TDAI_API_KEY"] = "tdai-key"
        import importlib
        import bridge.mcp.server as srv
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "mcp-specific-key"

def test_mcp_api_key_empty_loopback():
    """When both MCP_BRIDGE_API_KEY and TDAI_API_KEY are unset, should be empty (loopback)."""
    with patch.dict(os.environ, {}, clear=True):
        import importlib
        import bridge.mcp.server as srv
        importlib.reload(srv)
        assert srv._MCP_API_KEY == ""

def test_mcp_api_key_empty_string_explicit():
    """When MCP_BRIDGE_API_KEY is set to empty string, falls through to TDAI_API_KEY."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["MCP_BRIDGE_API_KEY"] = ""
        os.environ["TDAI_API_KEY"] = "fallback-key"
        import importlib
        import bridge.mcp.server as srv
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "fallback-key"


# 鈹€鈹€ Health fallback env-var consistency 鈹€鈹€

def test_health_api_key_fallback():
    """bridge.mcp_health should fall back from MCP_BRIDGE_API_KEY to TDAI_API_KEY."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["TDAI_API_KEY"] = "health-fallback-key"
        import importlib
        import bridge.mcp_health as health
        importlib.reload(health)
        assert health.MCP_API_KEY == "health-fallback-key"

def test_health_api_key_explicit():
    """bridge.mcp_health uses explicit MCP_BRIDGE_API_KEY when set."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["MCP_BRIDGE_API_KEY"] = "health-explicit-key"
        os.environ["TDAI_API_KEY"] = "should-not-be-used"
        import importlib
        import bridge.mcp_health as health
        importlib.reload(health)
        assert health.MCP_API_KEY == "health-explicit-key"


# 鈹€鈹€ MCP server TDAI_* inheritance 鈹€鈹€

def test_mcp_server_tdai_env_inheritance():
    """MCP server resolves API key from TDAI_API_KEY fallback."""
    with patch.dict(os.environ, {}, clear=True):
        os.environ["TDAI_API_KEY"] = "inherited-key"
        import importlib
        import bridge.mcp.server as srv
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "inherited-key"
