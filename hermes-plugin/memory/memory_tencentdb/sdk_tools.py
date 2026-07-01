"""TDAI 记忆工具包装器 — LangGraph / CrewAI / AutoGen 集成。

为三大 Python Agent 框架提供开箱即用的记忆工具。

用法:
    # LangGraph
    from sdk_tools import create_langgraph_memory_tools
    tools = create_langgraph_memory_tools(base_url="http://127.0.0.1:8420")

    # CrewAI
    from sdk_tools import TencentDBMemoryTool
    tool = TencentDBMemoryTool(base_url="http://127.0.0.1:8420")

    # AutoGen
    from sdk_tools import tencentdb_memory_function
    @tencentdb_memory_function("recall")
    def recall_memories(query: str, session_key: str) -> str:
        ...
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional
from dataclasses import dataclass

from .sdk_client import ResilientMemoryClient


# ============================
# LangGraph 集成
# ============================


def create_langgraph_memory_tools(
    base_url: str = "http://127.0.0.1:8420",
    timeout: int = 10,
) -> List[Callable]:
    """创建 LangGraph 兼容的记忆工具列表。

    返回标准 LangGraph Tool 对象列表，可在 StateGraph 中直接使用。

    Args:
        base_url: Gateway 基础 URL。
        timeout: 请求超时（秒）。

    Returns:
        LangGraph Tool 对象列表。

    用法:
        from langgraph.prebuilt import ToolNode
        tools = create_langgraph_memory_tools()
        tool_node = ToolNode(tools)
    """
    client = ResilientMemoryClient(base_url=base_url, timeout=timeout)

    # 尝试导入 langgraph 类型（如果可用）
    try:
        from langgraph.tool import tool as langgraph_tool
    except ImportError:
        # LangGraph 未安装，返回空列表
        return []

    @langgraph_tool
    def tdai_recall(query: str, session_key: str) -> str:
        """召回与当前查询相关的记忆上下文。"""
        result = client.recall(query, session_key)
        return result.get("context", "")

    @langgraph_tool
    def tdai_capture(user_content: str, assistant_content: str, session_key: str) -> str:
        """记录一次对话交互到记忆系统。"""
        result = client.capture(user_content, assistant_content, session_key)
        return f"已记录 {result.get('l0_recorded', 0)} 条对话"

    @langgraph_tool
    def tdai_search_memories(query: str) -> str:
        """搜索 L1 结构化记忆。"""
        result = client.search_memories(query)
        return result.get("results", "")

    return [tdai_recall, tdai_capture, tdai_search_memories]


# ============================
# CrewAI 集成
# ============================


@dataclass
class TencentDBMemoryTool:
    """CrewAI 兼容的记忆工具。

    用法:
        from crewai import Agent
        tool = TencentDBMemoryTool(base_url="http://127.0.0.1:8420")
        agent = Agent(tools=[tool])
    """

    base_url: str = "http://127.0.0.1:8420"
    timeout: int = 10
    name: str = "TencentDB Memory"
    description: str = "搜索和记录长期记忆"

    def __post_init__(self):
        self._client = ResilientMemoryClient(
            base_url=self.base_url,
            timeout=self.timeout,
        )

    def run(self, query: str) -> str:
        """执行记忆搜索（CrewAI Tool 接口）。"""
        try:
            result = self._client.search_memories(query)
            return result.get("results", "未找到相关记忆")
        except Exception as e:
            return f"记忆搜索失败: {e}"


# ============================
# AutoGen 集成
# ============================


def tencentdb_memory_function(
    operation: str,
    base_url: str = "http://127.0.0.1:8420",
) -> Callable:
    """AutoGen 函数装饰器 — 将函数注册为记忆操作。

    Args:
        operation: 记忆操作类型 ("recall", "capture", "search")。
        base_url: Gateway 基础 URL。

    用法:
        @tencentdb_memory_function("recall")
        def recall_memories(query: str, session_key: str) -> str:
            '''召回相关记忆。'''
            ...
    """
    client = ResilientMemoryClient(base_url=base_url)

    def decorator(func: Callable) -> Callable:
        def wrapper(*args: Any, **kwargs: Any) -> str:
            try:
                if operation == "recall":
                    query = kwargs.get("query", args[0] if args else "")
                    session_key = kwargs.get("session_key", args[1] if len(args) > 1 else "default")
                    result = client.recall(query, session_key)
                    return result.get("context", "")
                elif operation == "capture":
                    user_content = kwargs.get("user_content", args[0] if args else "")
                    assistant_content = kwargs.get("assistant_content", args[1] if len(args) > 1 else "")
                    session_key = kwargs.get("session_key", args[2] if len(args) > 2 else "default")
                    result = client.capture(user_content, assistant_content, session_key)
                    return json.dumps(result)
                elif operation == "search":
                    query = kwargs.get("query", args[0] if args else "")
                    result = client.search_memories(query)
                    return result.get("results", "")
                else:
                    return f"未知操作: {operation}"
            except Exception as e:
                return f"记忆操作失败: {e}"

        # 保留原函数的元数据
        wrapper.__name__ = func.__name__
        wrapper.__doc__ = func.__doc__
        return wrapper

    return decorator
