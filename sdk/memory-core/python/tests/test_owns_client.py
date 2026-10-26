"""close() must not close a caller-injected httpx client, only stub-owned ones."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx
import pytest

import tencentdb_agent_memory._http as v2
import tencentdb_agent_memory._v3_http as v3


def test_v2_sync_stub_leaves_injected_client_open():
    client = httpx.Client()
    stub = v2.HttpStub("https://x", "k", "svc", client=client)
    stub.close()
    assert client.is_closed is False


def test_v2_sync_stub_closes_owned_client():
    stub = v2.HttpStub("https://x", "k", "svc")
    stub.close()
    assert stub.client.is_closed is True


@pytest.mark.asyncio
async def test_v2_async_stub_leaves_injected_client_open():
    client = httpx.AsyncClient()
    stub = v2.AsyncHttpStub("https://x", "k", "svc", client=client)
    await stub.close()
    assert client.is_closed is False
    await client.aclose()


@pytest.mark.asyncio
async def test_v2_async_stub_closes_owned_client():
    stub = v2.AsyncHttpStub("https://x", "k", "svc")
    await stub.close()
    assert stub.client.is_closed is True


def test_v3_sync_stub_leaves_injected_client_open():
    client = httpx.Client()
    stub = v3.HttpStub("https://x", "k", "svc", client=client)
    stub.close()
    assert client.is_closed is False


@pytest.mark.asyncio
async def test_v3_async_stub_leaves_injected_client_open():
    client = httpx.AsyncClient()
    stub = v3.AsyncHttpStub("https://x", "k", "svc", client=client)
    await stub.close()
    assert client.is_closed is False
    await client.aclose()
