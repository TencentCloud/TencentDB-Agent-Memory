# TencentDB Agent Memory Python Gateway SDK

A dependency-free synchronous client for the public TencentDB Agent Memory
Gateway routes used by Python framework adapters.

```bash
pip install -e ./python-gateway-sdk
```

```python
from memory_tencentdb_gateway import TdaiGatewayClient

client = TdaiGatewayClient("http://127.0.0.1:8420")
context = client.recall("preferred output style", "python:demo")
```

The client validates base URLs, keeps credentials in the `Authorization`
header, clamps public search limits, validates JSON object responses, and
raises `TdaiGatewayError` with route and HTTP status details.
