"""Recall filter tests: append/template modes, off mode, fail-open/closed."""

from __future__ import annotations

import pytest
from semantic_kernel.functions import KernelArguments
from semantic_kernel.kernel import Kernel

from tdai_sk import MEMORY_PLACEHOLDER, TDAiConfig, TencentDBAgentMemory


async def _run_render_filters(kernel: Kernel, arguments: KernelArguments) -> str:
    """Drive the kernel's prompt_rendering_filters as the agent would."""
    # Imports stay in this frame under their REAL names: PromptRenderContext
    # .model_rebuild() resolves pydantic forward references by name from the
    # calling frame's locals (same trick SK itself uses in
    # kernel_filters_extension._rebuild_prompt_render_context). Aliasing
    # (as _X) breaks the resolution, so keep them plain.
    from semantic_kernel.filters import FilterTypes  # noqa: F401
    from semantic_kernel.filters.prompts.prompt_render_context import PromptRenderContext
    from semantic_kernel.functions import KernelFunction  # noqa: F401
    from semantic_kernel.functions.function_result import FunctionResult  # noqa: F401
    from semantic_kernel.functions.kernel_arguments import KernelArguments  # noqa: F401
    from semantic_kernel.kernel import Kernel  # noqa: F401

    PromptRenderContext.model_rebuild()

    inner_executed = {}

    async def inner(ctx):
        inner_executed["done"] = True

    function = kernel.add_function(
        plugin_name="test", function_name="dummy", prompt="render me"
    )
    stack = kernel.construct_call_stack(FilterTypes.PROMPT_RENDERING, inner)
    context = PromptRenderContext(kernel=kernel, function=function, arguments=arguments)
    await stack(context)
    assert inner_executed.get("done") is True
    return arguments.get("instructions") or ""


async def test_append_mode_injects_into_instructions(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="append"))
    kernel = Kernel()
    mem.attach(kernel)
    assert len(kernel.prompt_rendering_filters) == 1

    arguments = KernelArguments(input="What is my project codename?")
    rendered = await _run_render_filters(kernel, arguments)
    assert "Apollo Lake" in rendered
    assert "untrusted context" in rendered
    await mem.close()


async def test_append_mode_preserves_existing_instructions(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="append"))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments(
        input="What is my project codename?", instructions="You are concise."
    )
    rendered = await _run_render_filters(kernel, arguments)
    assert rendered.startswith("You are concise.")
    assert "Apollo Lake" in rendered
    await mem.close()


async def test_template_mode_writes_placeholder_only(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="template"))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments(input="What is my project codename?")
    await _run_render_filters(kernel, arguments)
    assert "Apollo Lake" in arguments[MEMORY_PLACEHOLDER]
    assert "untrusted context" in arguments[MEMORY_PLACEHOLDER]
    assert "instructions" not in arguments
    await mem.close()


async def test_off_mode_registers_no_filter(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="off"))
    kernel = Kernel()
    mem.attach(kernel)  # no-op
    assert len(kernel.prompt_rendering_filters) == 0

    arguments = KernelArguments(input="anything")
    rendered = await _run_render_filters(kernel, arguments)
    assert rendered == ""
    await mem.close()


async def test_attach_is_idempotent(fake_gw):
    _, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    kernel = Kernel()
    mem.attach(kernel)
    mem.attach(kernel)
    assert len(kernel.prompt_rendering_filters) == 1
    await mem.close()


async def test_recall_fail_open_keeps_prompt_clean(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/recall")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=True))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments(input="What is my codename?")
    rendered = await _run_render_filters(kernel, arguments)
    assert rendered == ""  # recall failure leaves the prompt untouched
    await mem.close()


async def test_recall_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/recall")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=False))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments(input="What is my codename?")
    with pytest.raises(Exception, match="500"):
        await _run_render_filters(kernel, arguments)
    await mem.close()


async def test_no_user_query_skips_recall(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments()  # no input at all
    rendered = await _run_render_filters(kernel, arguments)
    assert rendered == ""
    assert gw.payloads("/recall") == []  # gateway never called
    await mem.close()
