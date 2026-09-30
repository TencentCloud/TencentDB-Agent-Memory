"""Configuration for the TencentDB Agent Memory Semantic Kernel adapter.

Validation mirrors the security posture of the official adapters: remote
plaintext HTTP is rejected by default so bearer tokens are never sent in
cleartext to a non-local gateway, and identity fields must be non-empty so
every gateway request carries an explicit isolation scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})


class ConfigError(ValueError):
    """Raised when the adapter configuration is invalid."""


@dataclass
class TDAiConfig:
    """Configuration for :class:`TencentDBAgentMemory`.

    Attributes:
        app_name: Application identity sent on every gateway request.
        user_id: User identity sent on every gateway request.
        gateway_url: memory-core gateway base URL (default local sidecar).
        api_key: Optional bearer key; required when the gateway is started
            with ``TDAI_GATEWAY_API_KEY``.
        timeout: Per-request HTTP timeout in seconds.
        recall_mode: How recalled context is injected into the prompt:
            ``append`` (default) appends to the rendered instructions;
            ``template`` writes the ``{{TDaiMemory}}`` variable only;
            ``off`` disables automatic recall.
        max_context_chars: Hard bound on the recalled-context block injected
            into the prompt (defense against oversized recall payloads).
        allow_remote_http: Permit plaintext HTTP to a non-local gateway.
            Off by default; bearer tokens must not transit cleartext.
        memory_search_tool: Expose the ``memory_search`` kernel function.
        conversation_search_tool: Expose the ``conversation_search`` kernel
            function.
        fail_open: When True (default), memory errors are logged and
            swallowed so the chat path is never blocked by the gateway.
    """

    app_name: str = "semantic-kernel-app"
    user_id: str = "default-user"
    gateway_url: str = "http://127.0.0.1:8420"
    api_key: str = ""
    timeout: float = 5.0
    recall_mode: Literal["append", "template", "off"] = "append"
    max_context_chars: int = 4000
    allow_remote_http: bool = False
    memory_search_tool: bool = True
    conversation_search_tool: bool = True
    fail_open: bool = True

    def validate(self) -> None:
        """Validate the configuration; raise :class:`ConfigError` on issues."""
        if not self.app_name.strip():
            raise ConfigError("app_name must be a non-empty string")
        if not self.user_id.strip():
            raise ConfigError("user_id must be a non-empty string")
        if self.timeout <= 0:
            raise ConfigError("timeout must be positive")
        if self.max_context_chars <= 0:
            raise ConfigError("max_context_chars must be positive")

        parsed = urlparse(self.gateway_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ConfigError(
                f"gateway_url must be an http(s) URL, got: {self.gateway_url!r}"
            )
        if (
            parsed.scheme == "http"
            and parsed.hostname not in _LOCAL_HOSTS
            and not self.allow_remote_http
        ):
            raise ConfigError(
                "refusing to send the gateway API key over plaintext HTTP to a "
                "non-local host; use https, loopback http, or set "
                "allow_remote_http=True explicitly"
            )
