r"""TencentDB Agent Memory provider profile for hermes-agent.

为每个 hermes 会话动态注入 ``x-conversation-id`` header，配合
TencentDB Agent Memory Proxy（github.com/TencentCloud/TencentDB-Agent-Memory）
完成 session-init 表单的跨轮续跑与 session 状态保持。

机制与 OpenRouter 内置插件的 ``x-grok-conv-id`` 完全一致：
transport 在每次请求前调用 ``build_api_kwargs_extras(session_id=...)``，
profile 把 header 放进 top-level ``extra_headers``，随 OpenAI SDK 发出。

为什么 subclass ``CustomProfile`` 并注册为 ``custom``：
  hermes 0.20.x 运行时会把 named custom provider（config ``providers:`` 段
  的条目）的 ``agent.provider`` 统一重写为 ``"custom"``（config 里保留原名
  仅用于读取 base_url / api_key）。因此按 ``name="tdaimemory"`` 注册的
  profile 永远不会被运行时查到——``get_provider_profile(agent.provider)``
  查的是 ``"custom"``。provider 插件的发现顺序是 last-writer-wins
  （$HERMES_HOME 用户插件覆盖 bundled），这里用同名子类覆盖内置
  CustomProfile：Ollama num_ctx / reasoning_effort 等 quirk 全部经
  ``super()`` 保留，仅对 base_url 含 ``/hermes/`` 的请求（即指向本
  Proxy 的端点）追加会话 header，其他 custom 端点（vLLM / llama.cpp
  / Ollama）零影响。

安装（二选一）：
  1. 用户插件目录（推荐，随 hermes 自动发现）：
       mkdir -p ~/.hermes/plugins/model-providers        # Windows: %LOCALAPPDATA%\hermes\plugins\model-providers
       cp -r tdaimemory ~/.hermes/plugins/model-providers/tdaimemory
  2. hermes-agent 仓库内置目录：
       cp -r tdaimemory <hermes-agent>/plugins/model-providers/tdaimemory

配置（~/.hermes/config.yaml；Windows 为 %LOCALAPPDATA%\hermes\config.yaml）：
  model:
    default: <模型名>
    provider: tdaimemory      # 名字任意；运行时被重写为 custom，profile 由本插件接管
  providers:                  # v12+ keyed 段：承载连接信息
    tdaimemory:
      base_url: http://<proxy-host>:8096/hermes/<spaceId>/v1   # 必须含 /hermes/ 才会注入 header
      api_key: <sk-mem-... user_key>

注意：``__init__.py`` 里的 ``providers`` 导入报红属正常——该模块只在
hermes 运行环境内可解析。
"""

from dataclasses import dataclass
from typing import Any

from plugins.model_providers.custom import CustomProfile
from providers import register_provider


@dataclass
class TdaiProxyProfile(CustomProfile):
    """Custom/Ollama profile + TencentDB Agent Memory 会话 header 注入。

    仅当 base_url 含 ``/hermes/``（本 Proxy 的路由特征）且 session_id
    非空时追加 ``x-conversation-id: ses_<session_id>``。session_id 是
    hermes 当前交互会话的稳定标识（agent.session_id）；oneshot（``-z``）
    无持久 session_id → 不注入 → Proxy 跳过 session-init 直接透传，
    属预期 bypass。
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
        env_vars=(),  # No fixed key — custom endpoint
        base_url="",  # User-configured
        default_max_tokens=65536,
    )
)
