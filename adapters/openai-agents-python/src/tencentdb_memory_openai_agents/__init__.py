"""OpenAI Agents SDK integration for TencentDB Agent MemoryProxy."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import quote, urlsplit, urlunsplit

import httpx2
from agents import OpenAIChatCompletionsModel
from openai import AsyncOpenAI

__all__ = [
    "MemoryProxyConfig",
    "create_openai_client",
    "create_openai_model",
]

_ENV_FIELDS = {
    "proxy_url": "TDAI_MEMORY_PROXY_URL",
    "user_key": "TDAI_MEMORY_USER_KEY",
    "team_id": "TDAI_TEAM_ID",
    "agent_id": "TDAI_AGENT_ID",
    "task_id": "TDAI_TASK_ID",
    "conversation_id": "TDAI_CONVERSATION_ID",
}


def _require_header_value(name: str, value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError(f"{name} must not be empty")
    if "\r" in value or "\n" in value:
        raise ValueError(f"{name} must not contain line breaks")
    return value


def _normalize_proxy_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("TDAI_MEMORY_PROXY_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "TDAI_MEMORY_PROXY_URL must not include credentials, a query, or a fragment"
        )

    hostname = parsed.hostname.rstrip(".").lower()
    is_loopback = hostname == "localhost"
    if not is_loopback:
        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            pass
    if parsed.scheme == "http" and not is_loopback:
        raise ValueError("Remote MemoryProxy endpoints must use HTTPS")

    normalized_path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", ""))


@dataclass(frozen=True, slots=True)
class MemoryProxyConfig:
    """Validated connection and isolation settings for MemoryProxy."""

    proxy_url: str
    user_key: str = field(repr=False)
    team_id: str
    agent_id: str
    task_id: str
    conversation_id: str
    model: str = "gpt-4.1-mini"
    space_id: str = "default"

    def __post_init__(self) -> None:
        object.__setattr__(self, "proxy_url", _normalize_proxy_url(self.proxy_url))
        for field_name, env_name in _ENV_FIELDS.items():
            if field_name == "proxy_url":
                continue
            value = _require_header_value(env_name, getattr(self, field_name))
            object.__setattr__(self, field_name, value)
        object.__setattr__(
            self, "model", _require_header_value("TDAI_MODEL", self.model)
        )
        object.__setattr__(
            self, "space_id", _require_header_value("TDAI_SPACE_ID", self.space_id)
        )

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "MemoryProxyConfig":
        """Load configuration without assigning unsafe defaults to identity fields."""

        source = os.environ if environ is None else environ
        missing = [
            name for name in _ENV_FIELDS.values() if not source.get(name, "").strip()
        ]
        if missing:
            raise ValueError(
                f"Missing required environment variables: {', '.join(missing)}"
            )
        return cls(
            **{field: source[name] for field, name in _ENV_FIELDS.items()},
            model=source.get("TDAI_MODEL", "gpt-4.1-mini"),
            space_id=source.get("TDAI_SPACE_ID", "default"),
        )

    @property
    def openai_base_url(self) -> str:
        """Return the OpenAI-compatible endpoint consumed by the SDK client."""

        encoded_space = quote(self.space_id, safe="")
        return f"{self.proxy_url}/codebuddy/{encoded_space}/v1"

    @property
    def isolation_headers(self) -> dict[str, str]:
        """Return the complete MemoryProxy session identity."""

        return {
            "x-team-id": self.team_id,
            "x-agent-id": self.agent_id,
            "x-task-id": self.task_id,
            "x-conversation-id": self.conversation_id,
        }


def create_openai_client(
    config: MemoryProxyConfig,
    *,
    http_client: httpx2.AsyncClient | None = None,
) -> AsyncOpenAI:
    """Create an OpenAI client whose requests pass through MemoryProxy."""

    return AsyncOpenAI(
        api_key=config.user_key,
        base_url=config.openai_base_url,
        default_headers=config.isolation_headers,
        http_client=http_client,
        max_retries=2,
        timeout=60.0,
    )


def create_openai_model(
    config: MemoryProxyConfig,
    *,
    client: AsyncOpenAI,
) -> OpenAIChatCompletionsModel:
    """Create the model provider used by an OpenAI Agents SDK Agent."""

    return OpenAIChatCompletionsModel(
        model=config.model,
        openai_client=client,
    )
