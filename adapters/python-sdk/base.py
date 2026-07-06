"""Abstract base class for TDAI platform adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class RecallResult:
    context: str
    strategy: str = ""
    memory_count: int = 0


@dataclass
class CaptureResult:
    l0_recorded: int
    scheduler_notified: bool


@dataclass
class SearchResult:
    results: str
    total: int
    strategy: str = ""


@dataclass
class HealthStatus:
    status: str
    version: str = ""
    uptime: float = 0.0
    stores: Optional[Dict[str, bool]] = None


class TdaiAdapter(ABC):
    """Abstract base class for TDAI memory adapters.

    Any platform integrating TDAI memory must implement these 4 methods.
    The adapter handles the platform-specific lifecycle (hooks, events)
    and delegates storage/retrieval to these methods.
    """

    @abstractmethod
    def recall(self, query: str, session_key: str, **kwargs) -> RecallResult:
        """Retrieve relevant memories for a query.

        Called before each LLM turn to inject memory context.
        """
        ...

    @abstractmethod
    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        **kwargs,
    ) -> CaptureResult:
        """Record a completed conversation turn.

        Called after each LLM turn completes.
        """
        ...

    @abstractmethod
    def search_memories(self, query: str, **kwargs) -> SearchResult:
        """Search L1 structured memories."""
        ...

    @abstractmethod
    def search_conversations(self, query: str, **kwargs) -> SearchResult:
        """Search L0 raw conversation history."""
        ...

    def health(self) -> HealthStatus:
        """Check adapter health. Override for custom health logic."""
        return HealthStatus(status="ok")

    def end_session(self, session_key: str) -> bool:
        """Signal session end. Override if the platform needs flush."""
        return True

    def destroy(self) -> None:
        """Cleanup resources. Override for graceful shutdown."""
        pass
