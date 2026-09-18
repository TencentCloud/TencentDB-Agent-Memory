"""LangChain retriever for TencentDB Agent Memory.

:class:`TencentDBRetriever` turns L1 semantic recall into a
:class:`~langchain_core.retrievers.BaseRetriever`, so it drops into any RAG
chain (``create_retrieval_tool``, a ``RetrievalQA`` chain, etc.) without further
glue. Each hit becomes a :class:`~langchain_core.documents.Document` whose
``page_content`` is the fact text and whose ``metadata`` carries id / type /
score / timestamps.
"""

from __future__ import annotations

import asyncio
from typing import Any, List, Optional

from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever

from .client import MemoryFact, TencentDBMemory

__all__ = ["TencentDBRetriever"]


def _fact_to_document(fact: MemoryFact) -> Document:
    metadata: dict[str, Any] = {
        "id": fact.id,
        "type": fact.type,
        "score": fact.score,
        "created_at": fact.created_at,
        "updated_at": fact.updated_at,
        "background": fact.background,
    }
    # Drop None values so metadata stays clean and JSON-serialisable.
    metadata = {k: v for k, v in metadata.items() if v is not None}
    return Document(page_content=fact.content, metadata=metadata)


class TencentDBRetriever(BaseRetriever):
    """Retrieve distilled L1 memories for a query.

    Parameters
    ----------
    memory:
        A :class:`~tencentdb_langchain.TencentDBMemory` (sync client).
    top_k:
        Maximum number of facts to return (default 5).
    type:
        Optional fact-type filter forwarded to ``/v3/atomic/search``.
    """

    memory: TencentDBMemory
    top_k: int = 5
    type: Optional[str] = None

    def _get_relevant_documents(
        self, query: str, *, run_manager: Any = None
    ) -> List[Document]:
        facts = self.memory.search_facts(query, limit=self.top_k, type=self.type)
        return [_fact_to_document(f) for f in facts]

    async def _aget_relevant_documents(
        self, query: str, *, run_manager: Any = None
    ) -> List[Document]:
        # The sync client is httpx-based; run it in a thread to keep the event
        # loop free without maintaining a second async client.
        return await asyncio.to_thread(self._get_relevant_documents, query)
