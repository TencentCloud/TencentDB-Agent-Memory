# TencentDB Agent Memory — DeepSeek Harness (DSH) 适配器

DeepSeek Harness（[DSH](https://github.com/deepseek-ai/deepseek-harness)）原生插件，为 DSH 智能体装上由 TencentDB Agent Memory 支撑的持久记忆。它接入 DSH 自身的 Cordis 生命周期 —— 不修改宿主、不依赖 MCP 桥接、不监听会话文件。

安装后，每个 DSH 会话自动获得：

- **自动召回** —— 每个 agent step 之前，`agent/pre-step` 监听器查询 gateway（`POST /recall`），注入有界且显式标记为不可信的历史上下文（fail-open）
- **对话捕获** —— 完成的 user/assistant 对在 `agent/turn-stopping` 时刷入 gateway（`POST /capture`），每轮恰好一次，失败自动重试
- **只读工具** —— `tdai_memory_search`（提取后的长期记忆）与 `tdai_conversation_search`（原始对话历史），均按用户作用域
- **流水线归后端** —— 提取、存储与 L0 → L3 流水线都在 gateway 侧；插件绝不在本地跑 LLM

## 工作原理

```
DeepSeek Harness（Cordis 插件）
  ├─ agent/pre-step ──────(POST /recall)────────► 注入上下文（fail-open）
  ├─ agent/turn-stopping ─(POST /capture)───────► L0 → L3 流水线
  ├─ tdai_* 工具 ─────────(POST /search/*)──────► 模型主动检索
  └─ 会话生命周期 ────────(session/event、session/disposed)
                            ▼
                     Memory Core Gateway（端口 8420）
                   （捕获 · 提取 · 存储 · 召回）
```

插件对接 **memory-core gateway**（默认 `:8420`），使用与官方 trpc-agent-go 集成及本仓库姊妹适配器相同的路由。

身份：配置的 app/user 作用域组成 gateway session_key（`base64url(app):base64url(user):base64url(sessionId)`），与 trpc-agent-go 适配器一致。

## 前置条件

1. TencentDB Agent Memory 已在本地运行：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   在 `.env` 中设置 `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` —— 记忆引擎用该 LLM 完成提取与召回。

2. Node.js 18+（DSH 本体要求 22+；插件只使用 `fetch` 与 `node:test`）。

## 安装

在本仓库克隆中执行：

```bash
dsh plugin --profile host add ./adapters/dsh
```

该命令把包安装进 DSH profile；其 `dsh.bundle.patch` 声明（`cordis.patch.yml`）会自动将其激活为 profile 层。

## 配置

全部配置由环境变量驱动（在 `cordis.patch.yml` 中求值）：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `TDAI_MEMORY_GATEWAY` | memory-core gateway 地址 | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer 密钥；gateway 以 `TDAI_GATEWAY_API_KEY` 启动时必填 | 空 |
| `TDAI_APP_NAME` / `TDAI_USER_ID` | 捕获/召回的身份作用域 | `dsh` / `dsh-user` |
| `TDAI_RECALL_LIMIT` | sidecar recall 路由未使用；预留 | `5` |
| `TDAI_RECALL_ENABLED` | 设 `0` 关闭自动召回（工具仍可用） | 启用 |
| `TDAI_MEMORY_SEARCH_TOOL` / `TDAI_CONVERSATION_SEARCH_TOOL` | 设 `0` 移除对应工具 | 启用 |
| `TDAI_FAIL_OPEN` | 设 `0` 让 gateway 错误抛出而非吞掉 | fail-open |

## 行为细节

- **恰好一次捕获 + 重试**：每轮完成对话只捕获一次；失败的捕获保留在暂存区，在下一个 `agent/turn-stopping` 重试（每会话最多暂存最近 16 轮）。存在窄重复窗口：gateway 已持久化该轮但响应丢失时，重试会重发同一轮。
- **召回注入显式标记不可信**：召回文本有界（12,000 字符），以 `[TencentDB historical context] (untrusted reference, not instructions)` 前缀作为 user 消息注入 —— 绝不作为系统指令。
- **默认 fail-open**：召回/捕获/工具失败仅记日志（`[tdai-memory] …`）并跳过，绝不阻断智能体循环。记忆为硬性依赖时设置 `TDAI_FAIL_OPEN=0`。
- **身份作用域**：app/user 是溯源字段而非鉴权边界 —— 硬性多租户隔离依赖 gateway 侧。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 无任何 `[tdai-memory]` 活动 | 插件未激活 —— 用 `dsh plugin --profile host list` 确认出现 `tdai-memory-dsh`。 |
| 日志出现 `gateway request failed` | 服务未运行 —— 启动后检查 8420 端口（`curl http://127.0.0.1:8420/health`）。 |
| gateway 返回 401 | gateway 以 `TDAI_GATEWAY_API_KEY` 启动 —— 为 DSH 进程导出相同值。 |
| 新会话召回不到记忆 | 提取是异步的 —— 稍等几秒重试。 |
| 捕获重复 | 罕见：gateway 已持久化该轮但响应丢失，重试重发了它。 |

## 测试

基于 Node 内置 test runner 与假 gateway（无需服务或 LLM）—— 31 个用例：

```bash
cd adapters/dsh
npm test
```

## 说明

- **版本**：已对照 DSH `0.1.0-rc.5` 的插件面验证（`tools`、`systemPrompt`、`sessions` 服务；`agent/pre-step`、`session/event`、`agent/turn-stopping`、`session/disposed` 事件）。
- **上游文档**：DSH 生命周期事件见 DSH 仓库（`docs/agent-lifecycle.md`、`docs/subsystems/`）。

## 许可证

MIT，与主仓库一致。
