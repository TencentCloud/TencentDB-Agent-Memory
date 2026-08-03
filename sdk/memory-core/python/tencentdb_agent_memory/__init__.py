"""TencentDB Agent Memory Python SDK.

版本布局（参考 tencentcloud-sdk-python 子模块拆版本风格）：

- 默认导出 `MemoryClient` / `AsyncMemoryClient` 指向 v2 — 老代码升级 SDK 后零修改即可继续工作。
- 显式 import `from tencentdb_agent_memory.v3 import MemoryClient` 切到 v3
  isolation 版本（team/agent/user 构造时必填；session 对 L0 对话写入必填、
  读取可选，路径走 /v3）。

>>> # 老代码
>>> from tencentdb_agent_memory import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...")
>>> client.add_conversation(session_id="s1", messages=[...])

>>> # 新代码（严格 isolation）
>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...",
...                       team_id="t1", agent_id="a1", user_id="u1")
>>> client.add_conversation(session_id="s1", messages=[...])
"""

from .errors import ParamError, TDAMError
from .v2 import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient", "TDAMError", "ParamError"]
