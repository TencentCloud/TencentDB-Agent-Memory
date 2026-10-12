"""TencentDB Agent Memory v3 Python SDK — 严格 isolation 数据面客户端。

构造时必须提供 team_id / agent_id / user_id / session_id 四元组；
路径走 ``/v3/...``。详见 ``v3.client.MemoryClient`` docstring。

管理面客户端 :class:`MetadataClient` / :class:`AsyncMetadataClient` 不需要 isolation
四元组，封装 ``/v3/meta/*`` 公开接口（54 条，与 Panel ``META_ACTIONS`` 对齐）及
``/v3/knowledge/*`` Knowledge CRUD，详见 ``v3.metadata_client``。

Skill 客户端 :class:`SkillClient` / :class:`AsyncSkillClient` 封装 14 条
``/v3/skill/*`` 接口 —— skill 的 isolation 字段服务端 schema 层全部可选，
构造时按需传默认值即可，缺失时由 server 返回业务错误码（40001/40301/40302）。
"""

from .client import AsyncMemoryClient, MemoryClient
from .metadata_client import AsyncMetadataClient, MetadataClient
from .memory_prompt import AsyncMemoryPromptClient, MemoryPromptClient
from .memory_generation_log import AsyncMemoryGenerationLogClient, MemoryGenerationLogClient
from .skill_client import (
    SKILL_ERROR_CODE,
    AsyncSkillClient,
    SkillClient,
    encode_base64,
    encode_utf8,
)

__all__ = [
    "MemoryClient",
    "AsyncMemoryClient",
    "MetadataClient",
    "AsyncMetadataClient",
    "MemoryPromptClient",
    "AsyncMemoryPromptClient",
    "MemoryGenerationLogClient",
    "AsyncMemoryGenerationLogClient",
    "SkillClient",
    "AsyncSkillClient",
    "SKILL_ERROR_CODE",
    "encode_utf8",
    "encode_base64",
]
