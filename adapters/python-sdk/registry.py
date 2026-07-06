"""Adapter registry for multi-platform deployments."""

from __future__ import annotations

from typing import Dict, List, Optional

try:
    from .base import TdaiAdapter, HealthStatus
except ImportError:
    from base import TdaiAdapter, HealthStatus  # type: ignore


class TdaiAdapterRegistry:
    """Manages multiple named adapters with health aggregation."""

    def __init__(self):
        self._adapters: Dict[str, TdaiAdapter] = {}

    def register(self, name: str, adapter: TdaiAdapter) -> None:
        self._adapters[name] = adapter

    def get(self, name: str) -> Optional[TdaiAdapter]:
        return self._adapters.get(name)

    def unregister(self, name: str) -> None:
        self._adapters.pop(name, None)

    def list(self) -> List[str]:
        return list(self._adapters.keys())

    def health_all(self) -> Dict[str, HealthStatus]:
        results: Dict[str, HealthStatus] = {}
        for name, adapter in self._adapters.items():
            try:
                results[name] = adapter.health()
            except Exception as e:
                results[name] = HealthStatus(status=f"error: {e}")
        return results

    def destroy_all(self) -> None:
        for adapter in self._adapters.values():
            try:
                adapter.destroy()
            except Exception:
                pass
        self._adapters.clear()
