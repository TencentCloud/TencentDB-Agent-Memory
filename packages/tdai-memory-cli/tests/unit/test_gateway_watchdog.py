from tdai_memory_cli.config import load_config
from tdai_memory_cli.gateway_watchdog import run_watchdog
from tdai_memory_cli.runtime import (
    touch_heartbeat,
    write_gateway_process_info,
)


def test_watchdog_flushes_sessions_and_stops_idle_gateway(tmp_path):
    config = load_config({
        "TDAI_GATEWAY_RUNTIME_DIR": str(tmp_path / "runtime"),
        "TDAI_GATEWAY_LOG_DIR": str(tmp_path / "logs"),
        "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS": "10",
        "TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS": "1",
        "TDAI_USER_ID": "default-user",
    }, "/repo")
    write_gateway_process_info(config, pid=555, command=["node", "src/gateway/server.ts"], started_at=90)
    touch_heartbeat(config, session_key="session:1", user_id="user:1", now=100)

    calls = []

    def request_func(_config, path, *, body=None, **_kwargs):
        calls.append((path, body))
        return {"flushed": True}

    stopped = []

    def terminate_func(_config):
        stopped.append(True)
        return True

    result = run_watchdog(
        config,
        request_func=request_func,
        sleep_func=lambda _seconds: None,
        now_func=lambda: 111,
        terminate_func=terminate_func,
        is_alive_func=lambda pid: pid == 555,
    )

    assert result == "stopped-idle"
    assert calls == [("/session/end", {"session_key": "session:1", "user_id": "user:1"})]
    assert stopped == [True]
