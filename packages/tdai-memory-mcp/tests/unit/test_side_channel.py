from tdai_memory_mcp.side_channel import run_side_channel


class FakeClient:
    def __init__(self):
        self.calls = []

    def health(self):
        self.calls.append("health")
        return {"status": "ok", "version": "test", "uptime": 1, "stores": {"vectorStore": True, "embeddingService": True}}


def test_health_is_mcp_adapter_side_channel():
    client = FakeClient()
    result = run_side_channel(["health"], env={"TDAI_GATEWAY_URL": "http://127.0.0.1:8420"}, client=client)

    assert result["code"] == 0
    assert "status: ok" in result["stdout"]
    assert client.calls == ["health"]
