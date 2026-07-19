from tdai_memory_mcp.config import load_config
from tdai_memory_mcp.session import generate_default_session_key, resolve_session_key, sanitize_session_part


def test_sanitize_session_part_keeps_safe_chars():
    assert sanitize_session_part(" agent:abc_1.2 ") == "agent:abc_1.2"
    assert sanitize_session_part("a b/c") == "a-b-c"


def test_generate_default_session_key_is_stable():
    first = generate_default_session_key("/tmp/tencentdb-agent-memory")
    second = generate_default_session_key("/tmp/tencentdb-agent-memory")
    assert first == second
    assert first.startswith("mcp:tencentdb-agent-memory:")


def test_resolve_session_key_prefers_explicit():
    assert resolve_session_key(" explicit ", "default") == "explicit"
    assert resolve_session_key("", "default") == "default"


def test_load_config_reads_env():
    config = load_config({
        "TDAI_GATEWAY_URL": "http://localhost:9999/",
        "TDAI_GATEWAY_API_KEY": " secret ",
        "TDAI_SESSION_KEY": "session:abc",
        "TDAI_USER_ID": "user-1",
        "TDAI_REQUEST_TIMEOUT_MS": "1234",
        "TDAI_GATEWAY_AUTO_START": "true",
        "TDAI_GATEWAY_CWD": "/repo",
    }, "/fallback")

    assert config.gateway_url == "http://localhost:9999"
    assert config.api_key == "secret"
    assert config.default_session_key == "session:abc"
    assert config.user_id == "user-1"
    assert config.timeout_ms == 1234
    assert config.gateway_auto_start is True
    assert config.gateway_cwd == "/repo"
