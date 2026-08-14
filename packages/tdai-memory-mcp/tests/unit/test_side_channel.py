from tdai_memory_mcp.side_channel import run_side_channel


class FakeClient:
    def __init__(self):
        self.calls = []

    def health(self):
        self.calls.append("health")
        return {"status": "ok", "version": "test", "uptime": 1, "stores": {"vectorStore": True, "embeddingService": True}}


class FakeSupervisor:
    def __init__(self):
        self.calls = []

    def ensure_running(self):
        self.calls.append("ensure_running")

    def stop(self):
        self.calls.append("stop")


def test_health_is_mcp_adapter_side_channel():
    client = FakeClient()
    supervisor = FakeSupervisor()
    result = run_side_channel(["health"], env={"TDAI_GATEWAY_URL": "http://127.0.0.1:8420"}, client=client, supervisor=supervisor)

    assert result["code"] == 0
    assert "status: ok" in result["stdout"]
    assert client.calls == ["health"]
    assert supervisor.calls == ["ensure_running", "stop"]
