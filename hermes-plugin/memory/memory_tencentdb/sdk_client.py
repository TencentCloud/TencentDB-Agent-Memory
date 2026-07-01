"""MemoryTencentdbSdkClient — 增强版 HTTP 客户端，增加熔断和重试。

在原有 client.py 的 MemoryTencentdbSdkClient 基础上，
提供 CircuitBreaker + Retry 的独立可复用实现。
用于 LangGraph、CrewAI、AutoGen 等 Python Agent 框架。

用法:
    from hermes-plugin.memory.memory_tencentdb.sdk_client import ResilientMemoryClient

    client = ResilientMemoryClient(base_url="http://127.0.0.1:8420")
    context = client.recall("查询", "sess-1")
    client.capture("用户消息", "助手回复", "sess-1")
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.request
import urllib.error
from typing import Any, Callable, Dict, Optional, List
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

# ============================
# 熔断器
# ============================


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


@dataclass
class CircuitBreaker:
    """三态熔断器 — Python 版，与 TypeScript circuit-breaker.ts 逻辑一致。

    用法:
        breaker = CircuitBreaker(failure_threshold=5, timeout_sec=30)
        result = breaker.execute(lambda: do_http_call())
    """

    failure_threshold: int = 5
    timeout_sec: float = 30.0
    half_open_max: int = 1

    _state: CircuitState = CircuitState.CLOSED
    _failure_count: int = 0
    _open_timestamp: float = 0.0
    _half_open_in_flight: int = 0

    def execute(self, fn: Callable[[], Any]) -> Any:
        """通过熔断器执行操作。"""
        # OPEN → HALF_OPEN 超时检查
        if self._state == CircuitState.OPEN:
            elapsed = time.time() - self._open_timestamp
            if elapsed >= self.timeout_sec:
                self._state = CircuitState.HALF_OPEN
                self._failure_count = 0
            else:
                raise CircuitBreakerOpenError(
                    f"熔断器已打开 {elapsed:.0f}s, {self.timeout_sec - elapsed:.0f}s 后恢复"
                )

        if self._state == CircuitState.CLOSED:
            return self._execute_closed(fn)
        elif self._state == CircuitState.OPEN:
            raise CircuitBreakerOpenError("熔断器已打开")
        elif self._state == CircuitState.HALF_OPEN:
            return self._execute_half_open(fn)

    def _execute_closed(self, fn: Callable[[], Any]) -> Any:
        try:
            result = fn()
            self._failure_count = 0
            return result
        except Exception:
            self._failure_count += 1
            if self._failure_count >= self.failure_threshold:
                self._state = CircuitState.OPEN
                self._open_timestamp = time.time()
            raise

    def _execute_half_open(self, fn: Callable[[], Any]) -> Any:
        if self._half_open_in_flight >= self.half_open_max:
            raise CircuitBreakerOpenError("熔断器半开中，探测请求数已达上限")

        self._half_open_in_flight += 1
        try:
            result = fn()
            self._state = CircuitState.CLOSED
            self._failure_count = 0
            self._half_open_in_flight = 0
            return result
        except Exception:
            self._state = CircuitState.OPEN
            self._open_timestamp = time.time()
            self._half_open_in_flight = 0
            raise

    def reset(self) -> None:
        self._failure_count = 0
        self._half_open_in_flight = 0
        self._open_timestamp = 0.0
        self._state = CircuitState.CLOSED

    @property
    def state(self) -> CircuitState:
        return self._state


class CircuitBreakerOpenError(Exception):
    """熔断器打开时抛出。"""
    pass


# ============================
# 重试
# ============================


def with_retry(
    fn: Callable[[], Any],
    max_attempts: int = 3,
    initial_delay_sec: float = 0.2,
    max_delay_sec: float = 30.0,
    jitter: bool = True,
    retryable_codes: Optional[set] = None,
) -> Any:
    """指数退避重试 — Python 版，与 TypeScript retry.ts 逻辑一致。

    Args:
        fn: 要重试的函数。
        max_attempts: 最大重试次数（不含首次尝试）。
        initial_delay_sec: 初始退避延迟（秒）。
        max_delay_sec: 最大延迟上限（秒）。
        jitter: 是否启用随机抖动。
        retryable_codes: 可重试的 HTTP 状态码集合。
    """
    if retryable_codes is None:
        retryable_codes = {408, 425, 429, 500, 502, 503, 504}

    non_retryable_codes = {400, 401, 403, 404, 405, 409, 410, 422}

    last_error: Optional[Exception] = None

    for attempt in range(max_attempts + 1):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            last_error = e
            if e.code in non_retryable_codes:
                raise
            if e.code not in retryable_codes:
                raise
            if attempt >= max_attempts:
                raise
        except Exception as e:
            last_error = e
            if attempt >= max_attempts:
                raise

        # 计算退避
        delay = min(max_delay_sec, initial_delay_sec * (2 ** attempt))
        if jitter:
            delay = delay * (0.5 + random.random() * 0.5)

        time.sleep(delay)

    if last_error:
        raise last_error


# ============================
# 韧性客户端
# ============================


class ResilientMemoryClient:
    """韧性记忆客户端 — 整合熔断器 + 重试的 Gateway HTTP 客户端。

    兼容原 MemoryTencentdbSdkClient 的接口，可无缝替换。

    用法:
        client = ResilientMemoryClient(base_url="http://127.0.0.1:8420")
        client.recall("查询", "sess-1")
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        timeout: int = 10,
        api_key: Optional[str] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._api_key = (api_key or "").strip() or None
        self._breaker = CircuitBreaker()

    def _build_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        def _do() -> Dict[str, Any]:
            url = f"{self._base_url}{path}"
            data = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=self._build_headers(), method="POST")
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))

        resilient_fn = lambda: with_retry(lambda: self._breaker.execute(_do))
        return resilient_fn()

    def _get(self, path: str) -> Dict[str, Any]:
        def _do() -> Dict[str, Any]:
            url = f"{self._base_url}{path}"
            headers = self._build_headers()
            headers.pop("Content-Type", None)
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))

        resilient_fn = lambda: with_retry(lambda: self._breaker.execute(_do))
        return resilient_fn()

    def health(self) -> Dict[str, Any]:
        return self._get("/health")

    def recall(self, query: str, session_key: str) -> Dict[str, Any]:
        return self._post("/recall", {"query": query, "session_key": session_key})

    def capture(self, user_content: str, assistant_content: str, session_key: str) -> Dict[str, Any]:
        return self._post("/capture", {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        })

    def search_memories(self, query: str, limit: int = 5) -> Dict[str, Any]:
        return self._post("/search/memories", {"query": query, "limit": limit})

    def search_conversations(self, query: str, limit: int = 5) -> Dict[str, Any]:
        return self._post("/search/conversations", {"query": query, "limit": limit})

    def end_session(self, session_key: str) -> Dict[str, Any]:
        return self._post("/session/end", {"session_key": session_key})

    @property
    def circuit_state(self) -> str:
        return self._breaker.state.value

    def reset_circuit_breaker(self) -> None:
        self._breaker.reset()
