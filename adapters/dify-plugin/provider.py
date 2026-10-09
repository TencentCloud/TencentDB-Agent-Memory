"""
TencentDB Agent Memory - Dify Tool Plugin.

Implements Dify's Tool Provider interface for TDAI memory integration.
Provides 5 tools: recall, capture, memory_search, conversation_search, health.
"""

import json
import os
from typing import Any

import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python-sdk"))
from client import TdaiHttpClient
from base import RecallResult, CaptureResult, SearchResult, HealthStatus
from errors import TdaiError


GATEWAY_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")
API_KEY = os.environ.get("TDAI_API_KEY", "")


def _get_client() -> TdaiHttpClient:
    return TdaiHttpClient(gateway_url=GATEWAY_URL, api_key=API_KEY)


class TdaiMemoryProvider:
    """Dify Tool Provider for TDAI Memory.

    Register this provider in your Dify plugin manifest to expose
    memory tools in Dify workflows and agent conversations.
    """

    @staticmethod
    def get_tool_schemas() -> list[dict[str, Any]]:
        return [
            {
                "name": "tdai_recall",
                "label": {"en_US": "Recall Memories", "zh_Hans": "回忆记忆"},
                "description": {
                    "en_US": "Recall relevant memories for context injection",
                    "zh_Hans": "召回相关记忆用于上下文注入",
                },
                "parameters": [
                    {"name": "query", "type": "string", "required": True,
                     "label": {"en_US": "Query"}, "description": {"en_US": "User message to recall for"}},
                    {"name": "session_key", "type": "string", "required": True,
                     "label": {"en_US": "Session Key"}, "description": {"en_US": "Session identifier"}},
                ],
            },
            {
                "name": "tdai_capture",
                "label": {"en_US": "Capture Turn", "zh_Hans": "捕获对话"},
                "description": {
                    "en_US": "Capture a conversation turn into memory",
                    "zh_Hans": "将对话轮次记录到记忆中",
                },
                "parameters": [
                    {"name": "user_content", "type": "string", "required": True,
                     "label": {"en_US": "User Content"}, "description": {"en_US": "User message"}},
                    {"name": "assistant_content", "type": "string", "required": True,
                     "label": {"en_US": "Assistant Content"}, "description": {"en_US": "Assistant response"}},
                    {"name": "session_key", "type": "string", "required": True,
                     "label": {"en_US": "Session Key"}, "description": {"en_US": "Session identifier"}},
                ],
            },
            {
                "name": "tdai_memory_search",
                "label": {"en_US": "Search Memories", "zh_Hans": "搜索记忆"},
                "description": {
                    "en_US": "Search structured L1 memories",
                    "zh_Hans": "搜索结构化L1记忆",
                },
                "parameters": [
                    {"name": "query", "type": "string", "required": True,
                     "label": {"en_US": "Query"}, "description": {"en_US": "Search query"}},
                    {"name": "limit", "type": "number", "required": False,
                     "label": {"en_US": "Limit"}, "description": {"en_US": "Max results"}},
                ],
            },
            {
                "name": "tdai_conversation_search",
                "label": {"en_US": "Search Conversations", "zh_Hans": "搜索对话"},
                "description": {
                    "en_US": "Search raw L0 conversation history",
                    "zh_Hans": "搜索原始L0对话记录",
                },
                "parameters": [
                    {"name": "query", "type": "string", "required": True,
                     "label": {"en_US": "Query"}, "description": {"en_US": "Search query"}},
                    {"name": "limit", "type": "number", "required": False,
                     "label": {"en_US": "Limit"}, "description": {"en_US": "Max results"}},
                    {"name": "session_key", "type": "string", "required": False,
                     "label": {"en_US": "Session Key"}, "description": {"en_US": "Scope to session"}},
                ],
            },
            {
                "name": "tdai_health",
                "label": {"en_US": "Health Check", "zh_Hans": "健康检查"},
                "description": {
                    "en_US": "Check TDAI memory gateway health",
                    "zh_Hans": "检查TDAI记忆网关健康状态",
                },
                "parameters": [],
            },
        ]

    @staticmethod
    def invoke_tool(tool_name: str, parameters: dict[str, Any]) -> dict[str, Any]:
        client = _get_client()
        try:
            if tool_name == "tdai_recall":
                r = client.recall(parameters["query"], parameters["session_key"])
                return {"context": r.context, "strategy": r.strategy, "memory_count": r.memory_count}

            elif tool_name == "tdai_capture":
                r = client.capture(
                    parameters["user_content"],
                    parameters["assistant_content"],
                    parameters["session_key"],
                )
                return {"l0_recorded": r.l0_recorded, "scheduler_notified": r.scheduler_notified}

            elif tool_name == "tdai_memory_search":
                kwargs: dict[str, Any] = {}
                if "limit" in parameters:
                    kwargs["limit"] = int(parameters["limit"])
                r = client.search_memories(parameters["query"], **kwargs)
                return {"results": r.results, "total": r.total}

            elif tool_name == "tdai_conversation_search":
                kwargs = {}
                if "limit" in parameters:
                    kwargs["limit"] = int(parameters["limit"])
                if "session_key" in parameters:
                    kwargs["session_key"] = parameters["session_key"]
                r = client.search_conversations(parameters["query"], **kwargs)
                return {"results": r.results, "total": r.total}

            elif tool_name == "tdai_health":
                r = client.health()
                return {"status": r.status, "version": r.version, "uptime": r.uptime}

            else:
                return {"error": f"Unknown tool: {tool_name}"}

        except TdaiError as e:
            return {"error": str(e), "code": e.code}
