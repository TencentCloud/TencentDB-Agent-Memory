from __future__ import annotations

import asyncio

from langchain_core.documents import Document

from tencentdb_langchain import TencentDBRetriever

from conftest import FACT, build_sync_memory


def test_retrieve_returns_documents():
    memory = build_sync_memory({"/v3/atomic/search": {"items": [FACT]}})
    retriever = TencentDBRetriever(memory=memory, top_k=5)
    docs = retriever.invoke("theme")
    assert len(docs) == 1
    doc = docs[0]
    assert isinstance(doc, Document)
    assert doc.page_content == "The user prefers dark theme"
    assert doc.metadata["id"] == "fact-1"
    assert doc.metadata["score"] == 0.87
    assert doc.metadata["type"] == "preference"


def test_async_retrieve_returns_documents():
    memory = build_sync_memory({"/v3/atomic/search": {"items": [FACT]}})
    retriever = TencentDBRetriever(memory=memory, top_k=5)
    docs = asyncio.run(retriever.ainvoke("theme"))
    assert len(docs) == 1
    assert docs[0].page_content == "The user prefers dark theme"
