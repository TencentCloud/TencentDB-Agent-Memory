"""dify_memory_tencentdb — Dify 插件包入口。

导出 ``DifyEventBinding``（核心事件绑定）与 ``build_dify_binding``（工厂）。
工厂复用 ``hermes-plugin/memory/memory_tencentdb/client.py`` 的
``MemoryTencentdbSdkClient``，避免重复实现 HTTP 客户端。
"""

from __future__ import annotations

import importlib.util
import logging
import os
import pathlib
from typing import Any, Optional

from .event_binding import (
    DifyEventBinding,
    MEMORY_SEARCH_SCHEMA,
    CONVERSATION_SEARCH_SCHEMA,
    CAPTURE_SCHEMA,
)

logger = logging.getLogger("dify_memory_tencentdb")

__all__ = [
    "DifyEventBinding",
    "build_dify_binding",
    "MEMORY_SEARCH_SCHEMA",
    "CONVERSATION_SEARCH_SCHEMA",
    "CAPTURE_SCHEMA",
]


def _load_hermes_client_class():
    """从 hermes-plugin 动态加载 ``MemoryTencentdbSdkClient``。

    解析顺序：
      1. 环境变量 ``TDAI_HERMES_PLUGIN_PATH`` 指向 client.py
      2. 仓库内相对路径 ``<repo>/hermes-plugin/memory/memory_tencentdb/client.py``
         （本包位于 ``<repo>/dify-plugin/dify_memory_tencentdb/``，往上两级是仓库根）

    :returns: ``MemoryTencentdbSdkClient`` 类
    :raises ImportError: 找不到 client.py 时
    """
    candidates: list[Optional[pathlib.Path]] = []

    env_path = os.environ.get("TDAI_HERMES_PLUGIN_PATH", "").strip()
    if env_path:
        p = pathlib.Path(env_path)
        candidates.append(p if p.is_file() else p / "memory" / "memory_tencentdb" / "client.py")

    # 仓库内相对路径：本文件在 <repo>/dify-plugin/dify_memory_tencentdb/__init__.py
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    candidates.append(repo_root / "hermes-plugin" / "memory" / "memory_tencentdb" / "client.py")

    for client_py in candidates:
        if client_py and client_py.is_file():
            spec = importlib.util.spec_from_file_location("memory_tencentdb_client", client_py)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)  # type: ignore[arg-type]
                return mod.MemoryTencentdbSdkClient

    raise ImportError(
        "Cannot locate hermes-plugin/memory/memory_tencentdb/client.py. "
        "Set TDAI_HERMES_PLUGIN_PATH to the file or repo root."
    )


def build_dify_binding(
    *,
    host: Optional[str] = None,
    port: Optional[int] = None,
    api_key: Optional[str] = None,
    user_id: Optional[str] = None,
    session_key: str = "",
    client: Any = None,
) -> DifyEventBinding:
    """构造一个连真实 Gateway 的 ``DifyEventBinding``。

    环境变量回退（与 Hermes 对齐）：
      - ``MEMORY_TENCENTDB_GATEWAY_HOST`` （默认 127.0.0.1）
      - ``MEMORY_TENCENTDB_GATEWAY_PORT`` （默认 8420）
      - ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` / ``TDAI_GATEWAY_API_KEY``（回退）
      - ``TDAI_USER_ID`` （默认 default_user）

    :param client: 显式注入客户端（测试用）；为 None 时从 hermes-plugin 加载并构造。
    """
    if client is not None:
        return DifyEventBinding(
            client=client,
            user_id=user_id or os.environ.get("TDAI_USER_ID", "default_user"),
            session_key=session_key,
        )

    h = host or os.environ.get("MEMORY_TENCENTDB_GATEWAY_HOST", "127.0.0.1")
    p = port or int(os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT", "8420"))
    key = api_key or os.environ.get("MEMORY_TENCENTDB_GATEWAY_API_KEY") or os.environ.get("TDAI_GATEWAY_API_KEY")
    if key:
        key = key.strip() or None

    client_cls = _load_hermes_client_class()
    real_client = client_cls(
        base_url=f"http://{h}:{p}",
        api_key=key,
    )
    return DifyEventBinding(
        client=real_client,
        user_id=user_id or os.environ.get("TDAI_USER_ID", "default_user"),
        session_key=session_key,
    )
