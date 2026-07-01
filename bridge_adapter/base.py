"""
TdaiAdapter — 统一适配器 SDK 抽象基类.

所有 TDAI 平台适配器实现此接口。新平台只需:
  1. 继承 TdaiAdapter
  2. 实现 4 个内部方法 (_recall_impl / _capture_impl / _search_memory_impl / _search_conversation_impl)
  3. 注册到 TdaiAdapterRegistry

SDK 提供:
  - 参数校验 (长度/类型/边界) + 结构化错误类型 + 指数退避重试
  - 环境变量配置加载器 + 注册表健康聚合 + 中间件钩子
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import random
import re
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Type

logger = logging.getLogger("tdai_adapter_sdk")

# ════════════════════════════════════════════
# Constants
# ════════════════════════════════════════════

_MAX_QUERY_LENGTH = 100_000
_MAX_CONTENT_LENGTH = 1_000_000
_MAX_LIMIT = 1000
_MIN_LIMIT = 1
_DEFAULT_LIMIT = 5
_DEFAULT_TIMEOUT = 30.0

# Retry defaults
_RETRY_MAX_ATTEMPTS = 3
_RETRY_BASE_DELAY = 0.5  # seconds
_RETRY_MAX_DELAY = 10.0

# Registry name hygiene
_REGISTRY_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


# ════════════════════════════════════════════
# Structured errors
# ════════════════════════════════════════════

class TdaiError(Exception):
    """TDAI SDK 基类异常."""
    def __init__(self, message: str, cause: Optional[Exception] = None):
        super().__init__(message)
        self.cause = cause

class TdaiConnectionError(TdaiError):
    """Gateway 连接失败."""

class TdaiAuthError(TdaiError):
    """认证失败 (API key 无效/过期)."""

class TdaiTimeoutError(TdaiError):
    """请求超时."""

class TdaiRateLimitError(TdaiError):
    """频率限制."""

class TdaiValidationError(TdaiError):
    """参数校验失败."""


# ════════════════════════════════════════════
# Config
# ════════════════════════════════════════════

@dataclass
class TdaiConfig:
    """TDAI 适配器配置 — 支持 env var 和显式传入."""
    endpoint: str = "http://127.0.0.1:8420"
    api_key: str = ""
    service_id: str = "mem-rkgqhd5z"
    timeout: float = _DEFAULT_TIMEOUT
    retry_attempts: int = _RETRY_MAX_ATTEMPTS
    retry_base_delay: float = _RETRY_BASE_DELAY

    @classmethod
    def from_env(cls, prefix: str = "TDAI") -> "TdaiConfig":
        """从环境变量加载配置. 支持 TDAI_* 和 TD_* 两种前缀."""
        pf = prefix.upper()
        return cls(
            endpoint=os.environ.get(f"{pf}_ENDPOINT", "http://127.0.0.1:8420"),
            api_key=os.environ.get(f"{pf}_API_KEY", ""),
            service_id=os.environ.get(f"{pf}_SERVICE_ID", "mem-rkgqhd5z"),
            timeout=float(os.environ.get(f"{pf}_TIMEOUT", str(_DEFAULT_TIMEOUT))),
            retry_attempts=int(os.environ.get(f"{pf}_RETRY_ATTEMPTS", str(_RETRY_MAX_ATTEMPTS))),
            retry_base_delay=float(os.environ.get(f"{pf}_RETRY_BASE_DELAY", str(_RETRY_BASE_DELAY))),
        )


# ════════════════════════════════════════════
# Retry helper
# ════════════════════════════════════════════

def _exponential_backoff(attempt: int, base: float, max_delay: float = _RETRY_MAX_DELAY) -> float:
    """指数退避 + 抖动."""
    delay = min(base * (2 ** attempt), max_delay)
    jitter = random.uniform(0, delay * 0.1)
    return delay + jitter


def _is_retryable(error: Exception) -> bool:
    """可重试的错误类型."""
    return isinstance(error, (TdaiConnectionError, TdaiTimeoutError, TdaiRateLimitError,
                              ConnectionError, TimeoutError, OSError))


def _with_retry(fn: Callable, label: str, config: TdaiConfig,
                is_retryable_fn: Callable[[Exception], bool] = _is_retryable) -> Any:
    """执行 fn 并应用指数退避重试."""
    last_error = None
    for attempt in range(config.retry_attempts):
        try:
            return fn()
        except Exception as e:
            last_error = e
            if not is_retryable_fn(e) or attempt == config.retry_attempts - 1:
                raise
            delay = _exponential_backoff(attempt, config.retry_base_delay)
            logger.warning(f"[{label}] attempt {attempt+1}/{config.retry_attempts} failed, "
                          f"retrying in {delay:.1f}s: {e}")
            time.sleep(delay)
    raise last_error  # type: ignore[misc]


# ════════════════════════════════════════════
# Sanitization
# ════════════════════════════════════════════

def _sanitize_query(query: str) -> str:
    if not isinstance(query, str):
        raise TdaiValidationError(f"query must be str, got {type(query).__name__}")
    return query[:_MAX_QUERY_LENGTH]

def _sanitize_limit(limit: int) -> int:
    if not isinstance(limit, int):
        raise TdaiValidationError(f"limit must be int, got {type(limit).__name__}")
    return max(_MIN_LIMIT, min(limit, _MAX_LIMIT))

def _sanitize_content(content: str, label: str = "content") -> str:
    if not isinstance(content, str):
        raise TdaiValidationError(f"{label} must be str, got {type(content).__name__}")
    return content[:_MAX_CONTENT_LENGTH]


# ════════════════════════════════════════════
# Middleware
# ════════════════════════════════════════════

class TdaiMiddleware:
    """中间件基类. 在 recall/capture/search 前后执行钩子."""

    def before_call(self, method: str, **kwargs) -> None:
        """调用前执行 (可修改参数或阻断)."""

    def after_call(self, method: str, result: Any, duration: float) -> None:
        """调用后执行 (可记录指标/日志)."""

    def on_error(self, method: str, error: Exception) -> None:
        """异常时执行."""


class TdaiMetricsMiddleware(TdaiMiddleware):
    """记录调用计数和延迟的内置中间件."""

    def __init__(self):
        self._counts: Dict[str, int] = {}
        self._latencies: Dict[str, List[float]] = {}

    def before_call(self, method: str, **kwargs) -> None:
        self._call_start = time.time()

    def after_call(self, method: str, result: Any, duration: float) -> None:
        self._counts[method] = self._counts.get(method, 0) + 1
        self._latencies.setdefault(method, []).append(duration)

    @property
    def metrics(self) -> Dict[str, Any]:
        return {
            "calls": dict(self._counts),
            "avg_latency_ms": {
                k: (sum(v) / len(v) * 1000) if v else 0
                for k, v in self._latencies.items()
            },
        }


# ════════════════════════════════════════════
# Abstract base class
# ════════════════════════════════════════════

class TdaiAdapter(ABC):
    """统一适配器接口.

    子类只需实现 4 个 _impl 方法. 参数校验/重试/中间件由基类处理.
    """

    def __init__(self):
        self._config: Optional[TdaiConfig] = None
        self._middleware: List[TdaiMiddleware] = []
        self._metrics = TdaiMetricsMiddleware()
        self._middleware.append(self._metrics)

    def add_middleware(self, mw: TdaiMiddleware) -> None:
        """添加自定义中间件."""
        self._middleware.append(mw)

    @property
    def metrics(self) -> Dict[str, Any]:
        """获取调用指标."""
        return self._metrics.metrics

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @abstractmethod
    def initialize(self, **kwargs) -> None:
        ...

    @abstractmethod
    def is_available(self) -> bool:
        ...

    @abstractmethod
    def _recall_impl(self, query: str, limit: int) -> Dict[str, Any]:
        ...

    @abstractmethod
    def _capture_impl(self, user_content: str, assistant_content: str, session_id: str) -> bool:
        ...

    @abstractmethod
    def _search_memory_impl(self, query: str, limit: int) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def _search_conversation_impl(self, query: str, limit: int) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def shutdown(self) -> None:
        ...

    # ── Public API (with validation + retry + middleware) ──

    def _call_with_guards(self, method: str, impl_fn: Callable, *args) -> Any:
        """执行 impl_fn 并应用校验/中间件/重试."""
        for mw in self._middleware:
            mw.before_call(method)
        start = time.time()
        try:
            config = self._config or TdaiConfig()
            result = _with_retry(impl_fn, method, config)
            duration = time.time() - start
            for mw in self._middleware:
                mw.after_call(method, result, duration)
            return result
        except Exception as e:
            duration = time.time() - start
            for mw in self._middleware:
                mw.on_error(method, e)
            raise

    def recall(self, query: str, limit: int = _DEFAULT_LIMIT) -> Dict[str, Any]:
        q = _sanitize_query(query)
        l = _sanitize_limit(limit)
        try:
            return self._call_with_guards("recall", lambda: self._recall_impl(q, l))
        except Exception as e:
            logger.warning(f"recall failed: {e}")
            return {"prepend_context": "", "append_system_context": ""}

    def capture(self, user_content: str, assistant_content: str, session_id: str = "") -> bool:
        u = _sanitize_content(user_content, "user_content")
        a = _sanitize_content(assistant_content, "assistant_content")
        try:
            return self._call_with_guards("capture", lambda: self._capture_impl(u, a, session_id))
        except Exception as e:
            logger.warning(f"capture failed: {e}")
            return False

    def search_memory(self, query: str, limit: int = _DEFAULT_LIMIT) -> List[Dict[str, Any]]:
        q = _sanitize_query(query)
        l = _sanitize_limit(limit)
        try:
            return self._call_with_guards("search_memory", lambda: self._search_memory_impl(q, l))
        except Exception as e:
            logger.warning(f"search_memory failed: {e}")
            return []

    def search_conversation(self, query: str, limit: int = _DEFAULT_LIMIT) -> List[Dict[str, Any]]:
        q = _sanitize_query(query)
        l = _sanitize_limit(limit)
        try:
            return self._call_with_guards("search_conversation", lambda: self._search_conversation_impl(q, l))
        except Exception as e:
            logger.warning(f"search_conversation failed: {e}")
            return []

    # ── Optional overrides ──

    def mcp_health(self) -> Dict[str, Any]:
        return {"available": self.is_available()}

    def sync_profile(self, profile_data: Dict[str, Any]) -> bool:
        return False


# ════════════════════════════════════════════
# BufferedAdapter — buffered capture mixin
# ════════════════════════════════════════════


class BufferedAdapter(TdaiAdapter):
    """带本地缓冲的适配器 Mixin.

    覆盖 capture() 将对话写入本地 JSONL 文件, 而非实时网络 POST.
    在以下时机批量 flush 到 TDAI:
      - 缓冲行数达到 buffer_size
      - 主动调用 flush()
      - 进程退出 (atexit 注册)

    用法:
        class MyPlatformAdapter(BufferedAdapter):
            def _capture_impl(self, user_content, assistant_content, session_id):
                # 只在 flush 时被调用 (批量)
                ...
    """

    def __init__(self, buffer_size: int = 100, buffer_dir: str = ""):
        super().__init__()
        self._buffer_size = buffer_size
        self._buffer_dir = buffer_dir or os.environ.get(
            "TDAI_BUFFER_DIR",
            os.path.join(tempfile.gettempdir(), "tdai_buffer"),
        )
        os.makedirs(self._buffer_dir, exist_ok=True)
        self._buffer_path = os.path.join(self._buffer_dir, "capture_buffer.jsonl")
        self._buffer: List[Dict[str, str]] = []
        self._load_buffer()
        atexit.register(self.flush)

    def _load_buffer(self) -> None:
        """从磁盘恢复未 flush 的缓冲."""
        if not os.path.exists(self._buffer_path):
            return
        try:
            with open(self._buffer_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        self._buffer.append(json.loads(line))
            if self._buffer:
                logger.info(f"Loaded {len(self._buffer)} buffered captures from {self._buffer_path}")
        except Exception as e:
            logger.warning(f"Failed to load buffer: {e}")

    def _save_buffer(self) -> None:
        """将缓冲持久化到磁盘 JSONL."""
        try:
            with open(self._buffer_path, "w", encoding="utf-8") as f:
                for entry in self._buffer:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.warning(f"Failed to save buffer: {e}")

    def capture(self, user_content: str, assistant_content: str, session_id: str = "") -> bool:
        """缓冲写入本地 JSONL, 不触发网络调用.

        当 buffer 满时自动 flush.
        """
        u = _sanitize_content(user_content, "user_content")
        a = _sanitize_content(assistant_content, "assistant_content")
        turn = {
            "session_id": session_id or "default",
            "user": u,
            "assistant": a,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self._buffer.append(turn)
        self._save_buffer()  # 持久化保底

        if len(self._buffer) >= self._buffer_size:
            return self.flush()
        return True

    def flush(self) -> bool:
        """批量发送缓冲到 TDAI Gateway.

        对每条缓冲调 _capture_impl, 成功则清除.
        失败时保留缓冲, 下次继续尝试.
        """
        if not self._buffer:
            return True

        batch = list(self._buffer)
        success = True
        for entry in batch:
            try:
                ok = self._capture_impl(
                    entry["user"],
                    entry["assistant"],
                    entry.get("session_id", "default"),
                )
                if ok:
                    self._buffer.remove(entry)
                else:
                    success = False
                    logger.warning(f"flush failed for entry: {entry.get('session_id')}")
            except Exception as e:
                success = False
                logger.warning(f"flush error: {e}")

        self._save_buffer()
        return success

    def shutdown(self) -> None:
        """关闭前 flush 缓冲."""
        try:
            self.flush()
        except Exception as e:
            logger.warning(f"flush on shutdown failed: {e}")
        atexit.unregister(self.flush)
        super().shutdown()

    def buffer_size(self) -> int:
        """当前缓冲行数."""
        return len(self._buffer)

    def buffer_discard(self) -> None:
        """丢弃缓冲 (用于测试/紧急清理)."""
        self._buffer.clear()
        if os.path.exists(self._buffer_path):
            os.remove(self._buffer_path)
        logger.warning("Buffer discarded")


# ════════════════════════════════════════════
# Registry
# ════════════════════════════════════════════

class TdaiAdapterRegistry:
    """适配器注册表.

    不是安全边界 — 真正的边界是 Python import 系统.
    """

    _registry: Dict[str, Type[TdaiAdapter]] = {}

    @classmethod
    def register(cls, name: str, adapter_cls: Type[TdaiAdapter]) -> None:
        if not (isinstance(name, str) and _REGISTRY_NAME_RE.match(name)):
            raise ValueError(f"Invalid registry name: '{name}'. Must match {_REGISTRY_NAME_RE.pattern}")
        if not isinstance(adapter_cls, type) or not issubclass(adapter_cls, TdaiAdapter):
            raise TypeError(f"adapter_cls must be a TdaiAdapter subclass, got {adapter_cls}")
        if name in cls._registry:
            logger.warning(f"Overriding existing adapter: '{name}'")
        cls._registry[name] = adapter_cls
        logger.info(f"Registered adapter: {name} -> {adapter_cls.__name__}")

    @classmethod
    def get(cls, name: str) -> Optional[Type[TdaiAdapter]]:
        if not isinstance(name, str):
            return None
        return cls._registry.get(name)

    @classmethod
    def list(cls) -> List[str]:
        return list(cls._registry.keys())

    @classmethod
    def create(cls, name: str, **kwargs) -> Optional[TdaiAdapter]:
        adapter_cls = cls.get(name)
        if adapter_cls is None:
            logger.warning(f"Unknown adapter: {name}")
            return None
        instance = adapter_cls()
        instance.initialize(**kwargs)
        return instance

    @classmethod
    def health_all(cls) -> Dict[str, Dict[str, Any]]:
        """查询所有已注册适配器的健康状态."""
        results = {}
        for name, adapter_cls in cls._registry.items():
            try:
                inst = adapter_cls()
                inst.initialize()
                results[name] = {
                    "available": inst.is_available(),
                    "error": None,
                }
                inst.shutdown()
            except Exception as e:
                results[name] = {
                    "available": False,
                    "error": str(e),
                }
        return results
