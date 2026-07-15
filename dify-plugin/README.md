# Dify 适配器 — TDAI Memory（Pattern B-Python）

把 [TencentDB-Agent-Memory](../) 的记忆引擎接入 [Dify](https://dify.ai)，让 Dify 应用拥有跨会话长期记忆。

这是 Track 2（进程外）适配器的第二个实现，与 [Hermes 插件](../hermes-plugin/memory/memory_tencentdb/) 同属 Pattern B-Python：引擎跑在 HTTP Gateway 里，宿主侧只持一个 Python HTTP 客户端。

## 架构

```
┌──────────────────────────── Dify 应用 ────────────────────────────┐
│                                                                   │
│  用户提问                                                         │
│    │                                                              │
│    ▼                                                              │
│  ┌─────────────────────────┐    app.external_data_tool.query      │
│  │ External Data Tool 扩展点│ ─────────────────┐                  │
│  │ （recall：注入记忆上下文）│                   │                  │
│  └─────────────────────────┘                   ▼                  │
│  ┌─────────────────────────┐    Tool 节点调用   ┌───────────────┐ │
│  │ LLM 节点                │ ◀──── 注入 ────── │ DifyEvent-    │ │
│  └─────────────────────────┘                   │ Binding       │ │
│  ┌─────────────────────────┐    Tool 节点调用   │ (本插件)       │ │
│  │ tdai_capture 工具节点    │ ───────────────▶ │               │ │
│  │ （capture：写 L0）        │                   └───────┬───────┘ │
│  └─────────────────────────┘                           │         │
└────────────────────────────────────────────────────────┼─────────┘
                                                         │ HTTP
                                                         ▼
                                          ┌──────────────────────────┐
                                          │  TDAI Gateway :8420      │
                                          │  (TdaiCore L0→L1→L2→L3)  │
                                          └──────────────────────────┘
```

## 与 TS 侧 `HostEventBinding` 的对应

`DifyEventBinding`（[`dify_memory_tencentdb/event_binding.py`](dify_memory_tencentdb/event_binding.py)）实现 4 个方法，与 TS 侧 [`src/sdk/event-binding.ts`](../src/sdk/event-binding.ts) 一一对应：

| 方法 | Dify 触发方式 | Gateway 调用 |
|---|---|---|
| `on_user_prompt` | `app.external_data_tool.query` 扩展点（提问后、LLM 前） | `client.recall()` |
| `on_turn_end` | workflow 里的 `tdai_capture` Tool 节点 / 外部 webhook | `client.capture()` |
| `on_session_end` | 会话结束 webhook | `client.end_session()` |
| `get_tool_schemas` | Dify Tool 插件注册 | 返回 3 个工具 schema |

> **关键差异**：Dify **没有原生的「轮结束」事件**（不像 Claude Code 的 `Stop` 钩子或 Hermes 的 `sync_turn`）。capture 必须在 Dify workflow 里显式用一个 Tool 节点触发，或由外部 webhook 调用。这是 Dify 平台的限制，非本插件缺陷。

## 前置条件

1. **TDAI Gateway 已运行**在 `http://127.0.0.1:8420`（见 [根 README](../README.md)）
2. **Python ≥ 3.10**（与 Hermes 插件一致）
3. **pytest**（仅测试需要）：`pip install pytest`
4. **Dify**（可选，真实接入时需要）：支持 `external_data_tool` 扩展点 + Tool 插件

## 安装

本插件无需单独安装——它是仓库的一部分。复用 Hermes 插件的 `client.py`（零第三方依赖，仅 `urllib` + `json`）。

```bash
# 验证可导入
python -c "import sys; sys.path.insert(0, 'dify-plugin'); from dify_memory_tencentdb import DifyEventBinding; print(DifyEventBinding.host_type)"
# → dify
```

## 配置

环境变量（与 Hermes 插件完全对齐）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway 主机 |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway 端口 |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | — | Bearer 令牌（回退 `TDAI_GATEWAY_API_KEY`） |
| `TDAI_USER_ID` | `default_user` | 用户标识 |
| `TDAI_HERMES_PLUGIN_PATH` | — | 显式指定 `client.py` 路径（找不到时设置） |

## 使用

### 1. 构造 binding

```python
from dify_memory_tencentdb import build_dify_binding

# 从环境变量读配置，自动加载 hermes-plugin 的 client.py
binding = build_dify_binding(session_key="dify-app-abc")

# 或注入自定义 client（测试用）
from unittest.mock import MagicMock
binding = build_dify_binding(client=MagicMock())
```

### 2. recall（自动注入）

在 Dify 应用的「外部数据工具」配置里，指向一个调用 `binding.handle_external_data_tool_query` 的 HTTP 端点：

```python
# 例：FastAPI 端点（需自行部署）
from fastapi import FastAPI, Body
app = FastAPI()

@app.post("/api/dify/memory")
def memory_endpoint(data: dict = Body(...)):
    if data.get("point") == "ping":
        return {"result": "pong"}
    if data.get("point") == "app.external_data_tool.query":
        return binding.handle_external_data_tool_query(data["params"])
    return {"result": ""}
```

Dify 会在用户提问后、LLM 调用前请求这个端点，把返回的 `result` 注入 prompt。

### 3. capture（workflow Tool 节点）

在 Dify workflow 的 LLM 节点之后，加一个 Tool 节点调用 `tdai_capture`：

```python
# 在 Dify Tool 插件里
result_json = binding.handle_tool_call("tdai_capture", {
    "user_content": "<用户本轮输入>",
    "assistant_content": "<LLM 本轮回复>",
    "session_key": "dify-app-abc",
})
```

### 4. 搜索工具（模型按需调用）

`tdai_memory_search` 和 `tdai_conversation_search` 作为 Dify Tool 注册后，模型可主动调用：

```python
binding.handle_tool_call("tdai_memory_search", {"query": "装饰器", "limit": 5})
binding.handle_tool_call("tdai_conversation_search", {"query": "上次讨论", "limit": 3})
```

### 5. 会话结束

```python
binding.on_session_end(session_key="dify-app-abc")
```

## 测试

```bash
# 仓库根目录运行
python -m pytest dify-plugin/tests/test_event_binding.py -v
```

34 个契约测试覆盖：4 个 HostEventBinding 方法、Dify 扩展点适配器、软失败契约、limit clamp。全部用 mock client，不发真实 HTTP。

```
============================= 34 passed in 0.24s ==============================
```

## 与 Hermes 插件的对比

| 维度 | Hermes 插件 | Dify 适配器（本插件） |
|---|---|---|
| 宿主事件模型 | `prefetch` / `sync_turn` / `on_session_end`（原生钩子） | `external_data_tool.query` / Tool 节点 / webhook |
| recall 触发 | 宿主自动调 `prefetch` | Dify 扩展点自动调 |
| capture 触发 | 宿主自动调 `sync_turn`（fire-and-forget 线程） | **需在 workflow 显式接 Tool 节点**（Dify 无原生轮结束事件） |
| session-end | 宿主 `on_session_end` 钩子 | 需外部 webhook 触发 |
| 可靠性机制 | 熔断 + 看门狗 + 背压 + 自动拉起 Gateway | 无（demo 级，依赖 Gateway 预启动） |
| client.py | 自己持有 | **复用** hermes-plugin 的 `MemoryTencentdbSdkClient` |

## Dify 插件 manifest（参考）

真实部署为 Dify 插件时，需补 `manifest.yaml` + 前端 `schema.json`。骨架：

```yaml
# manifest.yaml（Dify Plugin SDK 格式，需 dify-plugin >= 0.8）
meta:
  version: 0.0.2
  minimum_dify_version: 0.15.0
type: extension
name: tdai-memory
version: 0.1.0
description: "TDAI four-layer memory for Dify — recall injection + capture + search."
extensions:
  - type: external_data_tool
    name: tdai_recall
    config:
      url: "http://<your-endpoint>/api/dify/memory"
tools:
  - name: tdai_memory_search
  - name: tdai_conversation_search
  - name: tdai_capture
```

> 本仓库交付到 demo 级：`DifyEventBinding` + 契约测试 + 接入文档。完整的 Dify 插件打包（manifest / schema / SDK runtime）留给实际部署时按 Dify 版本补齐。

## 相关文档

- [适配器架构总览](../docs/adapters/README.md)
- [三平台对比](../docs/adapters/platform-comparison.md)
- [Hermes 插件 README](../hermes-plugin/memory/memory_tencentdb/README.md)（同 Pattern B-Python）
- [Claude Code 适配器 README](../src/adapters/claude-code/README.md)（Pattern B-MCP）
- [TS SDK HostEventBinding 契约](../src/sdk/event-binding.ts)
