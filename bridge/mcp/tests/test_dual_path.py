"""Tests for dual-path configuration: local mode vs multi-tenant mode.

Tests the MCP server side of the dual-path configuration.
bridge_adapter TdaiConfig tests run in the fork's CI (test_config.py).
"""

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# -------- Path A: Local mode (zero config, defaults) --------

def test_local_mode_mcp_server():
    """Local mode MCP server: no API key should allow loopback."""
    import bridge.mcp.server as srv
    with patch.dict(os.environ, {}, clear=True):
        import importlib
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "", (
            "MCP server should accept empty key in local mode"
        )


# -------- Path B: Multi-tenant mode (explicit TDAI_SERVICE_ID) --------

def test_multi_tenant_mcp_server():
    """Multi-tenant MCP server: API key inherited from TDAI_API_KEY."""
    import bridge.mcp.server as srv
    with patch.dict(os.environ, {}, clear=True):
        os.environ["TDAI_API_KEY"] = "sk-mcp-multi"
        import importlib
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "sk-mcp-multi", (
            f"MCP server should inherit TDAI_API_KEY, got '{srv._MCP_API_KEY}'"
        )


# -------- MCP_BRIDGE_API_KEY override --------

def test_mcp_bridge_api_key_override():
    """MCP_BRIDGE_API_KEY overrides TDAI_API_KEY for MCP server."""
    import bridge.mcp.server as srv
    with patch.dict(os.environ, {}, clear=True):
        os.environ["MCP_BRIDGE_API_KEY"] = "mcp-only-key"
        os.environ["TDAI_API_KEY"] = "should-not-be-used"
        import importlib
        importlib.reload(srv)
        assert srv._MCP_API_KEY == "mcp-only-key", (
            "MCP_BRIDGE_API_KEY should take precedence"
        )


# -------- Dual path startup illustration (info-only) --------

def test_dual_path_demo():
    """Demonstrate both local and multi-tenant startup configs.
    
    Local mode (zero config):
        $ python -m bridge.mcp.server
        # Uses: http://127.0.0.1:8420, empty key (loopback), mem-rkgqhd5z
    
    Multi-tenant mode (per project):
        $ TDAI_SERVICE_ID=my-project python -m bridge.mcp.server
        # Uses: default endpoint, empty key, my-project service_id
        
    Remote Gateway mode:
        $ TDAI_ENDPOINT=https://cloud.example.com:8420 \\
        $ TDAI_API_KEY=sk-xxxx \\
        $ TDAI_SERVICE_ID=my-project \\
        $ python -m bridge.mcp.server
    """
    assert True  # Documentation-only test
