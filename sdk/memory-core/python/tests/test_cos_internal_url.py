import asyncio
from typing import Any, Dict

import httpx

from tencentdb_agent_memory.cos import (
    AsyncMemoryFileReader,
    MemoryFileReader,
    StsCredential,
)


def credential(cos_url: str) -> StsCredential:
    return StsCredential(
        {
            "CosUrl": cos_url,
            "TmpSecretId": "secret-id",
            "TmpSecretKey": "secret-key",
            "TmpToken": "token",
            "ExpirationTime": "2099-01-01T00:00:00Z",
            "PathPrefix": "memory_v2/cos_data/mem-1",
        },
    )


class StaticCredentialManager:
    def __init__(self, value: StsCredential) -> None:
        self.value = value

    def get_credential(self) -> StsCredential:
        return self.value

    def invalidate(self) -> None:
        return None


class AsyncStaticCredentialManager:
    def __init__(self, value: StsCredential) -> None:
        self.value = value

    async def get_credential(self) -> StsCredential:
        return self.value

    def invalidate(self) -> None:
        return None


def test_public_cos_url_remains_supported() -> None:
    value = credential("https://bucket-1.cos.ap-shanghai.myqcloud.com")

    assert value.bucket == "bucket-1"
    assert value.region == "ap-shanghai"
    assert value.cos_host == "bucket-1.cos.ap-shanghai.myqcloud.com"
    assert value.prefix == "memory_v2/cos_data/mem-1/"


def test_sync_reader_preserves_internal_cos_host() -> None:
    host = "bucket-1.cos-internal.ap-shanghai.tencentcos.cn"
    value = credential(f"https://{host}")
    seen: Dict[str, Any] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["host"] = request.headers["host"]
        return httpx.Response(200, text="memory")

    client = httpx.Client(transport=httpx.MockTransport(handle))
    reader = MemoryFileReader(
        StaticCredentialManager(value),  # type: ignore[arg-type]
        client=client,
    )

    try:
        assert reader.read("persona.md") == "memory"
    finally:
        reader.close()

    assert value.bucket == "bucket-1"
    assert value.region == "ap-shanghai"
    assert value.cos_host == host
    assert seen == {
        "url": f"https://{host}/memory_v2/cos_data/mem-1/persona.md",
        "host": host,
    }


def test_async_reader_preserves_internal_cos_host() -> None:
    host = "bucket-2.cos-internal.ap-guangzhou.tencentcos.cn"
    value = credential(f"https://{host}")
    seen: Dict[str, Any] = {}

    async def handle(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["host"] = request.headers["host"]
        return httpx.Response(200, text="scene")

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        reader = AsyncMemoryFileReader(
            AsyncStaticCredentialManager(value),  # type: ignore[arg-type]
            client=client,
        )
        try:
            assert await reader.read("scene_blocks/project.md") == "scene"
        finally:
            await reader.close()

    asyncio.run(run())

    assert value.cos_host == host
    assert seen == {
        "url": f"https://{host}/memory_v2/cos_data/mem-1/scene_blocks/project.md",
        "host": host,
    }
