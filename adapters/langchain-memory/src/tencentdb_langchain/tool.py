"""LangChain tools for TencentDB Agent Memory.

Two ready-made tools let an agent recall memories mid-conversation:

- ``memory_search`` — semantic search over distilled L1 facts (and raw L0
  conversations), returning a compact, model-readable summary.
- ``memory_recall`` — the "quick context bootstrap": L3 persona + L2 scenario
  index + top L1 facts for a query, mirroring how the MemoryProxy injects
  context on the first turn.

Factories return a :class:`~langchain_core.tools.StructuredTool` that can be
passed to ``ToolNode``, ``bind_tools``, or any LangChain/LangGraph agent.
"""

from __future__ import annotations

from typing import List, Optional

from langchain_core.tools import StructuredTool

from .client import (
    AsyncTencentDBMemory,
    ConversationRecord,
    MemoryFact,
    Scenario,
    TencentDBMemory,
)

__all__ = [
    "create_memory_search_tool",
    "create_async_memory_search_tool",
    "create_memory_recall_tool",
    "create_async_memory_recall_tool",
    "format_facts",
    "format_conversations",
]


def format_facts(facts: List[MemoryFact]) -> str:
    """Render a list of facts as a model-readable block."""
    if not facts:
        return "No relevant memories found."
    lines: List[str] = []
    for i, f in enumerate(facts, 1):
        score = f" (score={f.score:.3f})" if f.score is not None else ""
        head = f"[{f.type}] " if f.type else ""
        lines.append(f"{i}. {head}{f.content}{score}")
    return "\n".join(lines)


def format_conversations(records: List[ConversationRecord]) -> str:
    if not records:
        return "No relevant conversation excerpts found."
    lines: List[str] = []
    for i, r in enumerate(records, 1):
        role = f"{r.role}: " if r.role else ""
        lines.append(f"{i}. {role}{r.content}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# memory_search
# ---------------------------------------------------------------------------


def _make_search_fn(memory: TencentDBMemory, search_conversations: bool):
    def _search(query: str, limit: int = 5) -> str:
        """Search persistent memories about ``query``.

        Args:
            query: What to search for (e.g. a project, a past decision, a user preference).
            limit: Maximum number of facts to return.
        """
        facts = memory.search_facts(query, limit=limit)
        parts = ["# Memories", format_facts(facts)]
        if search_conversations:
            conversations = memory.search_conversations(query, limit=limit)
            parts += ["# Conversation excerpts", format_conversations(conversations)]
        return "\n\n".join(parts)

    return _search


def _make_async_search_fn(memory: AsyncTencentDBMemory, search_conversations: bool):
    async def _search(query: str, limit: int = 5) -> str:
        """Search persistent memories about ``query``.

        Args:
            query: What to search for (e.g. a project, a past decision, a user preference).
            limit: Maximum number of facts to return.
        """
        facts = await memory.search_facts(query, limit=limit)
        parts = ["# Memories", format_facts(facts)]
        if search_conversations:
            conversations = await memory.search_conversations(query, limit=limit)
            parts += ["# Conversation excerpts", format_conversations(conversations)]
        return "\n\n".join(parts)

    return _search


def create_memory_search_tool(
    memory: TencentDBMemory,
    *,
    name: str = "memory_search",
    search_conversations: bool = True,
) -> StructuredTool:
    """Build a sync ``memory_search`` tool backed by ``memory``."""
    return StructuredTool.from_function(
        func=_make_search_fn(memory, search_conversations),
        name=name,
        description=(
            "Search the agent's persistent memories (distilled facts and past "
            "conversations) for information relevant to the query. Use this to "
            "recall preferences, decisions, and context from earlier sessions."
        ),
    )


def create_async_memory_search_tool(
    memory: AsyncTencentDBMemory,
    *,
    name: str = "memory_search",
    search_conversations: bool = True,
) -> StructuredTool:
    """Build an async ``memory_search`` tool backed by ``memory``."""
    return StructuredTool.from_function(
        coroutine=_make_async_search_fn(memory, search_conversations),
        name=name,
        description=(
            "Search the agent's persistent memories (distilled facts and past "
            "conversations) for information relevant to the query. Use this to "
            "recall preferences, decisions, and context from earlier sessions."
        ),
    )


# ---------------------------------------------------------------------------
# memory_recall
# ---------------------------------------------------------------------------


def _format_scenarios(scenarios: List[Scenario]) -> str:
    if not scenarios:
        return "No scenarios yet."
    return "\n".join(f"- {s.path}" + (f": {s.summary}" if s.summary else "") for s in scenarios)


def _make_recall_fn(memory: TencentDBMemory):
    def _recall(query: str, limit: int = 5) -> str:
        """Load the agent's long-term context (persona, scenarios, and top memories).

        Args:
            query: What context is needed right now.
            limit: Maximum number of facts to include.
        """
        persona = memory.read_persona()
        scenarios = memory.list_scenarios()
        facts = memory.search_facts(query, limit=limit)
        parts = [
            "# Persona",
            persona.content or "(none)",
            "# Scenarios",
            _format_scenarios(scenarios),
            "# Relevant memories",
            format_facts(facts),
        ]
        return "\n\n".join(parts)

    return _recall


def _make_async_recall_fn(memory: AsyncTencentDBMemory):
    async def _recall(query: str, limit: int = 5) -> str:
        """Load the agent's long-term context (persona, scenarios, and top memories).

        Args:
            query: What context is needed right now.
            limit: Maximum number of facts to include.
        """
        persona = await memory.read_persona()
        scenarios = await memory.list_scenarios()
        facts = await memory.search_facts(query, limit=limit)
        parts = [
            "# Persona",
            persona.content or "(none)",
            "# Scenarios",
            _format_scenarios(scenarios),
            "# Relevant memories",
            format_facts(facts),
        ]
        return "\n\n".join(parts)

    return _recall


def create_memory_recall_tool(
    memory: TencentDBMemory, *, name: str = "memory_recall"
) -> StructuredTool:
    return StructuredTool.from_function(
        func=_make_recall_fn(memory),
        name=name,
        description=(
            "Load the agent's long-term context in one shot: its persona, the "
            "list of known scenarios, and the memories most relevant to the query. "
            "Use this at the start of a session to bootstrap context."
        ),
    )


def create_async_memory_recall_tool(
    memory: AsyncTencentDBMemory, *, name: str = "memory_recall"
) -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_make_async_recall_fn(memory),
        name=name,
        description=(
            "Load the agent's long-term context in one shot: its persona, the "
            "list of known scenarios, and the memories most relevant to the query. "
            "Use this at the start of a session to bootstrap context."
        ),
    )
