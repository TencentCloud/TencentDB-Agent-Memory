import pytest

from tdai_memory_mcp.config import load_config
from tdai_memory_mcp.supervisor import GatewaySupervisor


class HealthyClient:
    def __init__(self):
        self.calls = 0

    def health(self):
        self.calls += 1
        return {"status": "ok"}


class DownClient:
    def health(self):
        raise RuntimeError("down")


def test_ensure_running_returns_when_already_healthy():
    client = HealthyClient()
    config = load_config({"TDAI_GATEWAY_URL": "http://127.0.0.1:8420"}, "/tmp/repo")
    supervisor = GatewaySupervisor(config, client)

    supervisor.ensure_running()

    assert client.calls == 1


def test_ensure_running_reports_missing_start_config():
    config = load_config({"TDAI_GATEWAY_URL": "http://127.0.0.1:8420"}, "/tmp/repo")
    supervisor = GatewaySupervisor(config, DownClient())

    with pytest.raises(RuntimeError, match="TDAI_GATEWAY_AUTO_START=1"):
        supervisor.ensure_running()
