"""TencentDB Agent Memory adapter for LangChain / LangGraph.

Give a LangChain or LangGraph agent persistent memory backed by
`TencentDB Agent Memory <https://github.com/TencentCloud/TencentDB-Agent-Memory>`_:

- :class:`TencentDBStore` — LangGraph long-term memory (:class:`~langgraph.store.base.BaseStore`).
- :class:`TencentDBRetriever` — LangChain retriever for RAG chains.
- :func:`create_memory_search_tool` / :func:`create_memory_recall_tool` — ready-made agent tools.
- :func:`capture_conversation` / :func:`create_capture_node` — record conversations into L0.
"""

from .capture import (
    acapture_conversation,
    capture_conversation,
    create_capture_node,
    langchain_messages_to_dicts,
)
from .client import (
    AsyncTencentDBMemory,
    ConversationRecord,
    MemoryFact,
    Persona,
    Scenario,
    TencentDBMemory,
    config_from_dict,
    env_config,
)
from .retriever import TencentDBRetriever
from .store import TencentDBStore
from .tool import (
    create_async_memory_recall_tool,
    create_async_memory_search_tool,
    create_memory_recall_tool,
    create_memory_search_tool,
    format_conversations,
    format_facts,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "TencentDBMemory",
    "AsyncTencentDBMemory",
    "TencentDBStore",
    "TencentDBRetriever",
    "MemoryFact",
    "ConversationRecord",
    "Scenario",
    "Persona",
    "env_config",
    "config_from_dict",
    "create_memory_search_tool",
    "create_async_memory_search_tool",
    "create_memory_recall_tool",
    "create_async_memory_recall_tool",
    "format_facts",
    "format_conversations",
    "capture_conversation",
    "acapture_conversation",
    "create_capture_node",
    "langchain_messages_to_dicts",
]
