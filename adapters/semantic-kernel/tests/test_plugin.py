"""Plugin registration and tool invocation tests."""

from __future__ import annotations

import pytest
from semantic_kernel.functions import KernelArguments
from semantic_kernel.kernel import Kernel

from tdai_sk import TDAiConfig, TencentDBAgentMemory


async def test_plugin_exposes_both_tools(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    plugin = mem.as_plugin()
    assert plugin.name == "TencentDBMemory"
    fn_names = sorted(f.metadata.name for f in plugin.functions.values())
    assert fn_names == ["conversation_search", "memory_search"]
    await mem.close()


async def test_tools_respect_config_flags(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(
        TDAiConfig(gateway_url=url, memory_search_tool=False)
    )
    plugin = mem.as_plugin()
    fn_names = sorted(f.metadata.name for f in plugin.functions.values())
    assert fn_names == ["conversation_search"]
    await mem.close()


async def test_memory_search_invocation_through_kernel(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    kernel = Kernel()
    kernel.add_plugin(mem.as_plugin())
    memory_search = kernel.get_function("TencentDBMemory", "memory_search")
    result = await memory_search.invoke(
        kernel=kernel, arguments=KernelArguments(query="project codename", limit=3)
    )
    assert "Apollo Lake" in str(result)
    payload = gw.payloads("/search/memories")[0]
    assert payload["query"] == "project codename"
    assert payload["user_id"] == "default-user"
    await mem.close()


async def test_conversation_search_invocation(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    kernel = Kernel()
    kernel.add_plugin(mem.as_plugin())
    conv_search = kernel.get_function("TencentDBMemory", "conversation_search")
    result = await conv_search.invoke(
        kernel=kernel, arguments=KernelArguments(query="codename", limit=2)
    )
    assert "codename" in str(result)
    await mem.close()


async def test_tool_fail_open_returns_placeholder(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/search/memories")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=True))
    kernel = Kernel()
    kernel.add_plugin(mem.as_plugin())
    memory_search = kernel.get_function("TencentDBMemory", "memory_search")
    result = await memory_search.invoke(
        kernel=kernel, arguments=KernelArguments(query="q")
    )
    assert "unavailable" in str(result)
    await mem.close()


async def test_tool_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/search/memories")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=False))
    kernel = Kernel()
    kernel.add_plugin(mem.as_plugin())
    memory_search = kernel.get_function("TencentDBMemory", "memory_search")
    with pytest.raises(Exception, match="500"):
        await memory_search.invoke(
            kernel=kernel, arguments=KernelArguments(query="q")
        )
    await mem.close()
