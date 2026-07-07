"""DifyEventBinding — Dify 宿主侧事件绑定（Track 2，Python）。

把 Dify 的扩展点 / 工具调用映射到 ``MemoryTencentdbSdkClient`` 调用，
复用 ``hermes-plugin/memory/memory_tencentdb/client.py`` 的零依赖 HTTP 客户端。

与 TS 侧 ``HostEventBinding``（src/sdk/event-binding.ts）的 4 方法一一对应：
    on_user_prompt  → recall   （Dify: app.external_data_tool.query 扩展点）
    on_turn_end     → capture  （Dify: workflow Tool 节点 / 会话 webhook）
    on_session_end  → end_session（Dify: 会话结束 webhook）
    get_tool_schemas → 暴露 memory_search / conversation_search 工具

Dify 与 Hermes/Claude Code 的关键差异：
  - Dify **没有原生的「轮结束」事件**。capture 需在 Dify workflow 里用一个
    Tool 节点（``tdai_capture``）显式触发，或由外部 webhook 调用。
  - recall 走 Dify 的 ``app.external_data_tool.query`` 扩展点——用户提问后、
    LLM 调用前，Dify 把扩展点返回的 ``result`` 注入到 prompt 上下文。

错误处理原则（对齐 Hermes / Claude Code）：记忆永不阻塞对话。
  - on_user_prompt 失败 → 返回空串（不注入）
  - on_turn_end 失败 → 返回 None（不 capture）
  - on_session_end 失败 → 静默返回
  - get_tool_schemas 不应抛（返回静态常量）
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("dify_memory_tencentdb")

# ============================
# Dify 工具 schema（对齐 TS tool-schemas.ts + Hermes plugin.yaml）
# ============================

MEMORY_SEARCH_SCHEMA: Dict[str, Any] = {
    "name": "tdai_memory_search",
    "description": (
        "Search L1 structured memories (persona / episodic / instruction) "
        "via the TDAI Gateway. Use when the agent needs long-term recall. "
        "Limit: tdai_memory_search and tdai_conversation_search share a "
        "combined limit of 3 calls per turn. Stop searching after 3 total attempts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {
                "type": "integer",
                "description": "Max results (1-20, default 5).",
                "minimum": 1,
                "maximum": 20,
                "default": 5,
            },
            "type": {
                "type": "string",
                "description": "Filter by memory type: persona | episodic | instruction.",
                "enum": ["persona", "episodic", "instruction"],
            },
            "scene": {
                "type": "string",
                "description": "Optional filter by scene name.",
            },
        },
        "required": ["query"],
    },
}

CONVERSATION_SEARCH_SCHEMA: Dict[str, Any] = {
    "name": "tdai_conversation_search",
    "description": (
        "Search L0 raw conversation records via the TDAI Gateway. "
        "Use when the agent needs to recall exact past dialogue. "
        "Limit: tdai_memory_search and tdai_conversation_search share a "
        "combined limit of 3 calls per turn. Stop searching after 3 total attempts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {
                "type": "integer",
                "description": "Max results (1-20, default 5).",
                "minimum": 1,
                "maximum": 20,
                "default": 5,
            },
            "session_key": {
                "type": "string",
                "description": "Restrict to a specific session (optional).",
            },
        },
        "required": ["query"],
    },
}

CAPTURE_SCHEMA: Dict[str, Any] = {
    "name": "tdai_capture",
    "description": (
        "Capture a completed turn (user + assistant) into L0 via the TDAI Gateway. "
        "Dify has no native turn-end event — call this from a workflow Tool node."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "user_content": {"type": "string", "description": "User message text."},
            "assistant_content": {"type": "string", "description": "Assistant reply text."},
            "session_key": {
                "type": "string",
                "description": "Session grouping key (optional, falls back to binding default).",
            },
        },
        "required": ["user_content", "assistant_content"],
    },
}

# ============================
# DifyEventBinding
# ============================


class DifyEventBinding:
    """Track 2 宿主侧事件绑定（Dify）。

    持有一个 ``MemoryTencentdbSdkClient``（或任何 duck-typed 同契约对象），
    把 Dify 扩展点 / 工具调用翻译成 Gateway 调用。

    :param client:  任意实现了 recall/capture/end_session/search_memories/
                    search_conversations 的对象（生产用
                    ``MemoryTencentdbSdkClient``，测试可注入 mock）。
    :param user_id: 用户标识，默认 "default_user"。
    :param session_key: 默认会话分组键；单会话 demo 可固定，多会话由调用方覆盖。
    """

    host_type: str = "dify"

    def __init__(
        self,
        client: Any,
        user_id: str = "default_user",
        session_key: str = "",
    ) -> None:
        if not session_key:
            raise ValueError(
                "session_key is required — Gateway /recall and /capture reject "
                "empty values. Pass session_key explicitly or via "
                "build_dify_binding(session_key=...)."
            )
        self._client = client
        self._user_id = user_id
        self._session_key = session_key

    # ── HostEventBinding 4 方法（对齐 TS src/sdk/event-binding.ts）──────────

    def on_user_prompt(
        self,
        query: str,
        *,
        session_key: Optional[str] = None,
    ) -> str:
        """用户提问时触发（Dify ``app.external_data_tool.query`` 扩展点）。

        调 ``client.recall()`` 返回记忆上下文。失败返回空串（不注入）。
        """
        if not query:
            return ""
        sk = session_key or self._session_key
        try:
            result = self._client.recall(
                query=query,
                session_key=sk,
                user_id=self._user_id,
            )
            context = result.get("context", "") or ""
            if context:
                return f"## memory-tencentdb Memory\n{context}"
            return ""
        except Exception as e:  # noqa: BLE001 — 软失败，记忆不阻塞对话
            logger.debug("dify on_user_prompt failed: %s", e)
            return ""

    def on_turn_end(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_key: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """对话轮结束时触发（Dify workflow Tool 节点 / 外部 webhook）。

        调 ``client.capture()``。失败返回 None。
        返回 ``{"l0_recorded": int, "scheduler_notified": bool}``。
        """
        if not user_content or not assistant_content:
            return None
        sk = session_key or self._session_key
        try:
            result = self._client.capture(
                user_content=user_content,
                assistant_content=assistant_content,
                session_key=sk,
                user_id=self._user_id,
            )
            return {
                "l0_recorded": result.get("l0_recorded", 0),
                "scheduler_notified": result.get("scheduler_notified", False),
            }
        except Exception as e:  # noqa: BLE001
            logger.debug("dify on_turn_end failed: %s", e)
            return None

    def on_session_end(self, *, session_key: Optional[str] = None) -> None:
        """会话结束时触发（Dify 会话结束 webhook）。

        调 ``client.end_session()`` flush 当前会话状态。静默失败。
        """
        sk = session_key or self._session_key
        try:
            self._client.end_session(session_key=sk, user_id=self._user_id)
        except Exception as e:  # noqa: BLE001
            logger.debug("dify on_session_end failed: %s", e)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """返回此宿主暴露给 Dify Agent 的记忆工具 schema 列表。"""
        return [
            MEMORY_SEARCH_SCHEMA,
            CONVERSATION_SEARCH_SCHEMA,
            CAPTURE_SCHEMA,
        ]

    # ── Dify 扩展点适配器（把 Dify 协议载荷翻译成上面的方法调用）────────────

    def handle_external_data_tool_query(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Dify ``app.external_data_tool.query`` 扩展点入口。

        Dify 请求体::

            {"point": "app.external_data_tool.query",
             "params": {"app_id", "tool_variable", "inputs", "query"}}

        返回::

            {"result": "<注入到 prompt 的上下文>"}
        """
        query = params.get("query", "") or ""
        context = self.on_user_prompt(query)
        return {"result": context}

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any]) -> str:
        """Dify Tool 插件调用入口。

        :param tool_name: ``tdai_memory_search`` / ``tdai_conversation_search`` / ``tdai_capture``
        :param args:      工具参数（snake_case，对齐 Gateway）
        :returns:         JSON 字符串结果；未知工具 / 失败返回错误文本。
        """
        import json

        try:
            if tool_name == "tdai_memory_search":
                query = (args.get("query") or "").strip()
                if not query:
                    return json.dumps({"error": "query is required"})
                resp = self._client.search_memories(
                    query=query,
                    limit=_clamp_limit(args.get("limit")),
                    type_filter=args.get("type") or "",
                    scene=args.get("scene") or "",
                )
                return json.dumps(resp)
            if tool_name == "tdai_conversation_search":
                query = (args.get("query") or "").strip()
                if not query:
                    return json.dumps({"error": "query is required"})
                resp = self._client.search_conversations(
                    query=query,
                    limit=_clamp_limit(args.get("limit")),
                    session_key=args.get("session_key") or "",
                )
                return json.dumps(resp)
            if tool_name == "tdai_capture":
                user_content = (args.get("user_content") or "").strip()
                assistant_content = (args.get("assistant_content") or "").strip()
                if not user_content or not assistant_content:
                    return json.dumps({"error": "user_content and assistant_content are required"})
                ack = self.on_turn_end(
                    user_content,
                    assistant_content,
                    session_key=args.get("session_key"),
                )
                return json.dumps(ack or {"error": "capture failed"})
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
        except Exception as e:  # noqa: BLE001
            logger.debug("dify handle_tool_call(%s) failed: %s", tool_name, e)
            return json.dumps({"error": str(e)})


def _clamp_limit(raw: Any) -> int:
    """把 limit 参数防御性 clamp 到 [1, 20]；非法值返回 5（默认）。"""
    if raw is None or isinstance(raw, bool):
        return 5
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 5
    return max(1, min(20, n))
