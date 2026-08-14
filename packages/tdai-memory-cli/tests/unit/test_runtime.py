from tdai_memory_cli.config import load_config
from tdai_memory_cli.runtime import read_heartbeat, touch_heartbeat


def test_touch_heartbeat_records_session(tmp_path):
    config = load_config({
        "TDAI_GATEWAY_RUNTIME_DIR": str(tmp_path / "runtime"),
        "TDAI_GATEWAY_LOG_DIR": str(tmp_path / "logs"),
        "TDAI_USER_ID": "default-user",
    }, "/repo")

    assert touch_heartbeat(config, session_key=" session:1 ", user_id="", now=123.4)

    payload = read_heartbeat(config)
    assert payload["updated_at"] == 123.4
    assert payload["sessions"] == [{
        "session_key": "session:1",
        "user_id": "default-user",
        "updated_at": 123.4,
    }]
