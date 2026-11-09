from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

from tencentdb_agent_memory import cos


@pytest.fixture(
    params=[
        "persona.md",
        "scene_blocks/notes with spaces.md",
        "scene_blocks/\u8bb0\u5fc6.md",
        "scene_blocks/notes#1.md",
        "scene_blocks/why?.md",
        "scene_blocks/100%.md",
        "scene_blocks/literal%2Fname.md",
    ]
)
def path(request):
    return request.param


@pytest.fixture(params=[False, True], ids=["success", "refresh-on-403"])
def request_case(request, path):
    retry = request.param
    credentials = [
        cos.StsCredential(
            {
                "CosUrl": f"https://bucket-{index}.cos.ap-guangzhou.myqcloud.com",
                "TmpSecretId": f"fake-id-{index}",
                "TmpSecretKey": f"fake-key-{index}",
                "TmpToken": f"fake-token-{index}",
                "PathPrefix": prefix,
            }
        )
        for index, prefix in enumerate(
            ["memory/test", "memory/refreshed#prefix?literal%2F"]
        )
    ][: 2 if retry else 1]
    requests = []

    def handler(req):
        requests.append(req)
        if retry and len(requests) == 1:
            return httpx.Response(403, text="Expired credentials")
        return httpx.Response(200, text="Memory content")

    def assert_requests(sign):
        assert len(requests) == len(credentials)
        assert sign.call_count == len(credentials)
        for req, cred, call in zip(requests, credentials, sign.call_args_list):
            expected_path = f"/{cred.prefix}{path}"
            assert req.url.path == expected_path
            assert req.url.query == b""
            assert req.url.fragment == ""
            assert req.url.host == cred.cos_host
            assert req.headers["host"] == cred.cos_host
            assert req.headers["x-cos-security-token"] == cred.token
            assert req.headers["authorization"]
            assert call.kwargs["path"] == expected_path
            assert call.kwargs["host"] == cred.cos_host

    return credentials, httpx.MockTransport(handler), assert_requests


def test_read_preserves_object_key(path, request_case):
    credentials, transport, assert_requests = request_case
    sts = Mock(spec=cos.StsCredentialManager)
    sts.get_credential.side_effect = credentials

    with httpx.Client(transport=transport) as client:
        reader = cos.MemoryFileReader(sts, client=client)
        with patch.object(cos, "_cos_v5_sign", wraps=cos._cos_v5_sign) as sign:
            assert reader.read(path) == "Memory content"
        assert_requests(sign)

    assert sts.get_credential.call_count == len(credentials)
    assert sts.invalidate.call_count == len(credentials) - 1


@pytest.mark.asyncio
async def test_async_read_preserves_object_key(path, request_case):
    credentials, transport, assert_requests = request_case
    sts = Mock(spec=cos.AsyncStsCredentialManager)
    sts.get_credential = AsyncMock(side_effect=credentials)

    async with httpx.AsyncClient(transport=transport) as client:
        reader = cos.AsyncMemoryFileReader(sts, client=client)
        with patch.object(cos, "_cos_v5_sign", wraps=cos._cos_v5_sign) as sign:
            assert await reader.read(path) == "Memory content"
        assert_requests(sign)

    assert sts.get_credential.await_count == len(credentials)
    assert sts.invalidate.call_count == len(credentials) - 1
