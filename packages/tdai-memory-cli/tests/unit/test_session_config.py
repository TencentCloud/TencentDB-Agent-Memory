from tdai_memory_cli.config import load_config
from tdai_memory_cli.session import generate_default_session_key, resolve_session_key


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
    }, "/fallback")

    assert config.gateway_url == "http://localhost:9999"
    assert config.api_key == "secret"
    assert config.default_session_key == "session:abc"
    assert config.user_id == "user-1"
    assert config.timeout_ms == 1234
