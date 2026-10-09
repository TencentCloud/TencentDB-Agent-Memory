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
        "TDAI_GATEWAY_AUTO_START": "1",
        "TDAI_GATEWAY_CMD": "node server.js",
        "TDAI_GATEWAY_CWD": "/repo",
        "TDAI_GATEWAY_CONFIG": "/repo/config.yaml",
        "TDAI_GATEWAY_STARTUP_TIMEOUT_MS": "4321",
        "TDAI_GATEWAY_HEALTH_POLL_MS": "321",
        "TDAI_GATEWAY_RUNTIME_DIR": "/repo/runtime",
        "TDAI_GATEWAY_LOG_DIR": "/repo/logs",
        "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS": "99",
        "TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS": "7",
    }, "/fallback")

    assert config.gateway_url == "http://localhost:9999"
    assert config.api_key == "secret"
    assert config.default_session_key == "session:abc"
    assert config.user_id == "user-1"
    assert config.timeout_ms == 1234
    assert config.gateway_auto_start is True
    assert config.gateway_command == "node server.js"
    assert config.gateway_cwd == "/repo"
    assert config.gateway_config_path == "/repo/config.yaml"
    assert config.gateway_startup_timeout_ms == 4321
    assert config.gateway_health_poll_ms == 321
    assert config.gateway_runtime_dir == "/repo/runtime"
    assert config.gateway_log_dir == "/repo/logs"
    assert config.gateway_idle_timeout_seconds == 99
    assert config.gateway_watchdog_interval_seconds == 7
