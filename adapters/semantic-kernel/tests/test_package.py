"""Package-level tests: public API surface and packaging sanity."""

from __future__ import annotations

from pathlib import Path


def test_public_api_exports():
    import tdai_sk

    for name in (
        "ConfigError",
        "GatewayError",
        "MEMORY_PLACEHOLDER",
        "TDAiConfig",
        "TencentDBAgentMemory",
    ):
        assert hasattr(tdai_sk, name), f"missing public export: {name}"
    assert tdai_sk.MEMORY_PLACEHOLDER == "TDaiMemory"


def test_facade_surfaces_exist():
    from tdai_sk import TencentDBAgentMemory

    for method in ("as_plugin", "attach", "capture_thread", "end_session", "health", "close"):
        assert callable(getattr(TencentDBAgentMemory, method)), f"missing surface: {method}"


def test_package_config_includes_runtime_package():
    from pathlib import Path

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    content = pyproject.read_text(encoding="utf-8")
    assert 'packages = ["tdai_sk"]' in content
    assert 'name = "tdai-sk"' in content


def test_no_credentials_in_sources():
    """The contribution must not contain real credentials or absolute paths."""
    import re

    root = Path(__file__).resolve().parents[1]
    pattern = re.compile(r"sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|[A-Z]:\\\\Users\\\\")
    for path in list((root / "tdai_sk").rglob("*.py")) + list((root / "tests").rglob("*.py")) + [
        root / "example" / "quickstart.py"
    ]:
        assert not pattern.search(path.read_text(encoding="utf-8")), f"suspicious content in {path}"
