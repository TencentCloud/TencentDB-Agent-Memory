#!/usr/bin/env python3
"""tdaimemory-provider-plugin 自测脚本（不依赖 pytest）。

模拟 hermes `_discover_providers()` 的加载顺序（bundled → user），
验证插件覆盖内置 `custom` profile 后的 6 个关键行为：

  1. get_provider_profile("custom") 命中 TdaiProxyProfile（last-writer-wins）
  2. base_url 含 /hermes/ 且有 session_id → 注入 x-conversation-id: ses_<sid>
  3. Ollama 等其他 custom 端点 → 不注入（且 ollama num_ctx quirk 保留）
  4. 无 session_id（oneshot）→ 不注入
  5. 内置 CustomProfile 的 reasoning quirk 不回归
  6. custom aliases 保持原 health-check 能力，只有 /hermes/ 的 model listing 被跳过

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
    # 常见安装位置（pip install -e 的 checkout / 常见 clone 路径）
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
    """按 hermes providers/_discover_providers 的 bundled 方式加载插件。"""
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

    # step 1: bundled 先加载（hermes 的发现顺序：bundled → user）
    _load_bundled_plugin(repo, "custom")

    # step 2: user 插件（本目录）
    _load_user_plugin()

    from providers import get_provider_profile

    failures = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(
            f"  [{'PASS' if cond else 'FAIL'}] {name}"
            + (f" — {detail}" if detail else "")
        )
        if not cond:
            failures.append(name)

    p = get_provider_profile("custom")
    check(
        "custom profile is overridden by TdaiProxyProfile",
        type(p).__name__ == "TdaiProxyProfile",
        f"got {type(p).__name__}",
    )

    proxy_url = "http://localhost:8096/hermes/default/v1"
    sid = "20260830_150940_ce0835"

    eb, tl = p.build_api_kwargs_extras(session_id=sid, base_url=proxy_url)
    hdr = (tl or {}).get("extra_headers") or {}
    check(
        "proxy base_url → injects x-conversation-id with ses_ prefix",
        hdr.get("x-conversation-id") == f"ses_{sid}",
        str(hdr),
    )

    eb2, tl2 = p.build_api_kwargs_extras(
        session_id=sid,
        base_url="http://127.0.0.1:11434/v1",
        ollama_num_ctx=8192,
    )
    check(
        "ollama base_url → no header injected (zero side-effect)",
        not ((tl2 or {}).get("extra_headers")),
        str(tl2),
    )
    check(
        "ollama num_ctx quirk preserved (super() delegation)",
        "options" in (eb2 or {}),
        str(sorted((eb2 or {}).keys())),
    )

    eb3, tl3 = p.build_api_kwargs_extras(session_id=None, base_url=proxy_url)
    check(
        "no session_id (oneshot) → no header injected",
        not (tl3 or {}).get("extra_headers"),
    )

    eb4, tl4 = p.build_api_kwargs_extras(
        session_id=sid,
        base_url=proxy_url,
        reasoning_config={"effort": "medium"},
        supports_reasoning=True,
    )
    check(
        "reasoning kwargs still flow through (super() delegation)",
        isinstance(eb4, dict)
        and isinstance(tl4, dict)
        and (tl4 or {}).get("extra_headers", {}).get("x-conversation-id")
        == f"ses_{sid}",
    )

    check(
        "custom aliases preserve supports_health_check",
        p.supports_health_check is True,
        f"got {p.supports_health_check!r}",
    )
    check(
        "proxy base_url skips unsupported model listing",
        p.fetch_models(api_key="unused", base_url=proxy_url) is None,
    )

    print()
    if failures:
        print(f"SELFTEST FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("SELFTEST PASSED (all checks green).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
