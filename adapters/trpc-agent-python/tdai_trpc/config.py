"""Configuration for the TencentDB Agent Memory trpc-agent-python adapter.

Validation mirrors the security posture of the sibling adapters: remote
plaintext HTTP is rejected by default so bearer tokens are never sent in
cleartext to a non-local gateway.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})


class ConfigError(ValueError):
    """Raised when the adapter configuration is invalid."""


@dataclass
class TDAiConfig:
    """Gateway configuration for :class:`TencentDBMemoryService`.

    Attributes:
        gateway_url: memory-core gateway base URL (default local sidecar).
        api_key: Optional bearer key; required when the gateway is started
            with ``TDAI_GATEWAY_API_KEY``.
        timeout: Per-request HTTP timeout in seconds.
        app_name / user_id: Fallback identity scope used when a session's
            ``save_key`` cannot be parsed into ``{app}/{user}`` parts. The
            session's own ``save_key`` takes precedence so memories are
            scoped exactly like the framework's other memory services.
        allow_remote_http: Permit plaintext HTTP to a non-local gateway.
            Off by default; bearer tokens must not transit cleartext.
        fail_open: When True (default), gateway errors during
            ``store_session`` / ``search_memory`` are logged and swallowed
            (returning an empty response) so the agent loop is never blocked,
            matching the failure posture of the framework's other remote
            memory services.
    """

    gateway_url: str = "http://127.0.0.1:8420"
    api_key: str = ""
    timeout: float = 5.0
    app_name: str = "trpc-agent-app"
    user_id: str = "default-user"
    allow_remote_http: bool = False
    fail_open: bool = True

    def validate(self) -> None:
        """Validate the configuration; raise :class:`ConfigError` on issues."""
        if self.timeout <= 0:
            raise ConfigError("timeout must be positive")
        if not self.app_name.strip():
            raise ConfigError("app_name must be a non-empty string")
        if not self.user_id.strip():
            raise ConfigError("user_id must be a non-empty string")

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
