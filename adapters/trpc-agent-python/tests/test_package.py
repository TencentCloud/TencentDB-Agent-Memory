"""Package-level tests: public API surface, packaging, credential scan."""

from __future__ import annotations

import re
from pathlib import Path


def test_public_api_exports():
    import tdai_trpc

    for name in (
        "ConfigError",
        "GatewayError",
        "MemoryGatewayClient",
        "TDAiConfig",
        "TencentDBMemoryService",
    ):
        assert hasattr(tdai_trpc, name), f"missing public export: {name}"


def test_service_implements_framework_contract():
    from trpc_agent_sdk.abc import MemoryServiceABC

    from tdai_trpc import TencentDBMemoryService

    assert issubclass(TencentDBMemoryService, MemoryServiceABC)
    for method in ("store_session", "search_memory", "close"):
        assert callable(getattr(TencentDBMemoryService, method))


def test_package_config_includes_runtime_package():
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    content = pyproject.read_text(encoding="utf-8")
    assert 'packages = ["tdai_trpc"]' in content
    assert 'name = "tdai-trpc"' in content
    assert "trpc-agent-py" in content


def test_no_credentials_in_sources():
    """The contribution must not contain real credentials or absolute paths."""
    root = Path(__file__).resolve().parents[1]
    pattern = re.compile(r"sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|[A-Z]:\\\\Users\\\\")
    paths = (
        list((root / "tdai_trpc").rglob("*.py"))
        + list((root / "tests").rglob("*.py"))
        + [root / "example" / "quickstart.py"]
    )
    for path in paths:
        if not path.exists():
            continue
        assert not pattern.search(path.read_text(encoding="utf-8")), (
            f"suspicious content in {path}"
        )
