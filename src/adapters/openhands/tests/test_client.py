import json
from unittest.mock import patch

from tdai_openhands.client import TdaiGatewayClient
from tdai_openhands.config import GatewayConfig


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self) -> bytes:
        return b'{"flushed": true}'


def test_session_end_uses_its_long_running_timeout() -> None:
    config = GatewayConfig(timeout_seconds=2.0, session_end_timeout_seconds=90.0)
    with patch("urllib.request.urlopen", return_value=_Response()) as urlopen:
        result = TdaiGatewayClient(config).session_end(session_key="openhands/tui/test")

    assert result == {"flushed": True}
    assert urlopen.call_args.kwargs["timeout"] == 90.0


def test_capture_forwards_turn_start_timestamp() -> None:
    config = GatewayConfig(timeout_seconds=2.0)
    with patch("urllib.request.urlopen", return_value=_Response()) as urlopen:
        TdaiGatewayClient(config).capture(
            user_content="user",
            assistant_content="assistant",
            session_key="openhands/tui/test",
            started_at=123456789,
        )

    request = urlopen.call_args.args[0]
    assert json.loads(request.data)["started_at"] == 123456789
