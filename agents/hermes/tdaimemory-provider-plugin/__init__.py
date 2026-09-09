r"""TencentDB Agent Memory provider profile for hermes-agent.

为每个 hermes 会话动态注入 ``x-conversation-id`` header，配合
TencentDB Agent Memory Proxy 完成 session-init 表单的跨轮续跑与 session 状态保持。

机制与 OpenRouter 内置插件的 ``x-grok-conv-id`` 完全一致：
transport 在每次请求前调用 ``build_api_kwargs_extras(session_id=...)``，
profile 把 header 放进 top-level ``extra_headers``，随 OpenAI SDK 发出。

为什么 subclass ``CustomProfile`` 并注册为 ``custom``：
  hermes 0.20.x 运行时会把 named custom provider 的 ``agent.provider`` 统一
  重写为 ``"custom"``。因此按原名注册的 profile 永远不会被运行时查到。
  provider 插件的发现顺序是 last-writer-wins，这里用同名子类覆盖内置
  CustomProfile：Ollama num_ctx / reasoning_effort 等 quirk 全部经
  ``super()`` 保留，仅对 base_url 含 ``/hermes/`` 的请求追加会话 header。

安装（二选一）：
  1. 用户插件目录（推荐）：
       mkdir -p ~/.hermes/plugins/model-providers
       cp -r tdaimemory ~/.hermes/plugins/model-providers/tdaimemory
  2. hermes-agent 仓库内置目录

配置（~/.hermes/config.yaml）：
  model:
    default: <模型名>
    provider: tdaimemory      # 名字任意；运行时被重写为 custom
  providers:
    tdaimemory:
      base_url: http://<proxy-host>:8096/hermes/<spaceId>/v1
      api_key: <sk-mem-... user_key>
"""

from dataclasses import dataclass
from typing import Any

from plugins.model_providers.custom import CustomProfile
from providers import register_provider


@dataclass
class TdaiProxyProfile(CustomProfile):
    """Custom/Ollama profile + TencentDB Agent Memory 会话 header 注入。

    仅当 base_url 含 ``/hermes/``（本 Proxy 的路由特征）且 session_id
    非空时追加 ``x-conversation-id: ses_<session_id>``。oneshot（``-z``）
    无持久 session_id → 不注入 → Proxy 跳过 session-init 直接透传。
    """

    @staticmethod
    def _is_tdai_proxy(base_url: str | None) -> bool:
        return bool(base_url) and "/hermes/" in base_url

    def fetch_models(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 8.0,
    ) -> list[str] | None:
        if self._is_tdai_proxy(base_url):
            return None
        return super().fetch_models(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )

    def build_api_kwargs_extras(
        self,
        *,
        session_id: str | None = None,
        **context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body, top_level = super().build_api_kwargs_extras(
            session_id=session_id, **context
        )
        if session_id and self._is_tdai_proxy(context.get("base_url")):
            headers = dict(top_level.get("extra_headers") or {})
            headers.setdefault("x-conversation-id", f"ses_{session_id}")
            top_level["extra_headers"] = headers
        return extra_body, top_level


register_provider(
    TdaiProxyProfile(
        name="custom",
        aliases=(
            "ollama",
            "local",
            "vllm",
            "llamacpp",
            "llama.cpp",
            "llama-cpp",
        ),
        env_vars=(),
        base_url="",
        default_max_tokens=65536,
    )
)
