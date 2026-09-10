#!/usr/bin/env python3
"""tdaimemory-provider-plugin 自测脚本（不依赖 pytest）。

模拟 hermes `_discover_providers()` 的加载顺序（bundled → user），
验证插件覆盖内置 `custom` profile 后的关键行为。

用法（需已安装 hermes-agent，或用 HERMES_AGENT_DIR 指向其 checkout）：
    python selftest.py
    HERMES_AGENT_DIR=/path/to/hermes-agent python selftest.py
"""

import importlib.util
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent


def _find_hermes_agent() -> Path:
    env = os.environ.get("HERMES_AGENT_DIR")
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    candidates = [
        Path.home() / "hermes-agent",
        Path.home() / "Desktop" / "Projects" / "hermes-agent",
        Path("/opt/hermes-agent"),
    ]
    for p in candidates:
        if (p / "providers" / "__init__.py").is_file():
            return p
    raise SystemExit(
        "ERROR: cannot locate hermes-agent checkout. "
        "Set HERMES_AGENT_DIR=/path/to/hermes-agent and retry."
    )


def _load_bundled_plugin(repo: Path, name: str) -> None:
    d = repo / "plugins" / "model-providers" / name
    spec = importlib.util.spec_from_file_location(
        f"plugins.model_providers.{name.replace('-', '_')}",
        d / "__init__.py",
        submodule_search_locations=[str(d)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)


def _load_user_plugin() -> None:
    spec = importlib.util.spec_from_file_location(
        "_hermes_user_provider_tdaimemory",
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)


def main() -> int:
    repo = _find_hermes_agent()
    sys.path.insert(0, str(repo))

    _load_bundled_plugin(repo, "custom")
    _load_user_plugin()

    from providers import get_provider_profile

    failures = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
        if not cond:
            failures.append(name)

    p = get_provider_profile("custom")
    check("custom profile is overridden by TdaiProxyProfile", type(p).__name__ == "TdaiProxyProfile")

    proxy_url = "http://localhost:8096/hermes/default/v1"
    sid = "20260830_150940_ce0835"

    eb, tl = p.build_api_kwargs_extras(session_id=sid, base_url=proxy_url)
    hdr = (tl or {}).get("extra_headers") or {}
    check("proxy base_url → injects x-conversation-id", hdr.get("x-conversation-id") == f"ses_{sid}")

    eb2, tl2 = p.build_api_kwargs_extras(session_id=sid, base_url="http://127.0.0.1:11434/v1", ollama_num_ctx=8192)
    check("ollama base_url → no header injected", not ((tl2 or {}).get("extra_headers")))
    check("ollama num_ctx quirk preserved", "options" in (eb2 or {}))

    eb3, tl3 = p.build_api_kwargs_extras(session_id=None, base_url=proxy_url)
    check("no session_id (oneshot) → no header", not (tl3 or {}).get("extra_headers"))

    check("proxy base_url skips model listing", p.fetch_models(api_key="unused", base_url=proxy_url) is None)

    print()
    if failures:
        print(f"SELFTEST FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("SELFTEST PASSED (all checks green).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
