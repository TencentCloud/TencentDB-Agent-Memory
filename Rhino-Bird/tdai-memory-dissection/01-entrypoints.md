# 01 入口映射

## 入口表

| 外部事件 | 代码入口 | 初始化内容 | 备注 |
| --- | --- | --- | --- |
| OpenClaw 加载 plugin | `index.ts` `register()` | `OpenClawHostAdapter`, `TdaiCore`, tools, hooks | 进程内路径，不需要 Gateway HTTP。 |
| OpenClaw turn 前事件 | `index.ts` `api.on("before_prompt_build")` | recall cache, embedding warmup | 调 `core.handleBeforeRecall()`。 |
| OpenClaw turn 后事件 | `index.ts` `api.on("agent_end")` | scheduler start, L0 capture | 调 `core.handleTurnCommitted()`。 |
| OpenClaw 进程关闭 | `index.ts` `api.on("gateway_stop")` | cleanup | 调 `core.destroy()`。 |
| Gateway 进程启动 | `src/gateway/server.ts` `main()` | `TdaiGateway`, `StandaloneHostAdapter`, `TdaiCore` | `node --import tsx src/gateway/server.ts`。 |
| HTTP recall/capture/search | `TdaiGateway.handleRequest()` | route handlers | `/recall`, `/capture`, `/search/*`, `/session/end`。 |
| Hermes provider 加载 | `hermes-plugin/.../__init__.py` `register(ctx)` | `MemoryTencentdbProvider` | Hermes 原生 MemoryProvider。 |
| Hermes session 初始化 | `MemoryTencentdbProvider.initialize()` | `GatewaySupervisor`, SDK client, watchdog | 后台拉起或连接 Gateway。 |
| Codex/Claude MCP 启动 | `packages/tdai-memory-mcp/.../__main__.py` | `McpServer` | stdio JSON-RPC server。 |
| MCP tool 调用 | `protocol.py` `tools/call` | `GatewaySupervisor.ensure_running()` | 调 Gateway `/search/*`。 |
| Codex/Claude hook 触发 | `tdai-memory-hook` `hook.py` | event parsing | stdin JSON 转 CLI args。 |
| CLI 命令执行 | `tdai-memory` `__main__.py` | config + Gateway health/start | `session-start/prefetch/sync-turn/end-session`。 |

## 启动时序

```mermaid
sequenceDiagram
  autonumber
  participant Host as Codex/Claude/Hermes/OpenClaw
  participant Plugin as Platform adapter
  participant GW as Gateway
  participant Core as TdaiCore
  participant Store as Store/Embedding/Pipeline

  alt OpenClaw in-process
    Host->>Plugin: load index.ts
    Plugin->>Core: new TdaiCore(OpenClawHostAdapter)
    Core->>Store: initialize data dirs + store + scheduler
    Plugin-->>Host: register tools and hooks
  else Gateway 旁路进程平台
    Host->>Plugin: load plugin/provider/MCP/hook
    Plugin->>GW: health check
    alt 不健康且 auto-start 已启用
      Plugin->>GW: start node --import tsx src/gateway/server.ts
    end
    GW->>Core: new TdaiCore(StandaloneHostAdapter)
    Core->>Store: initialize data dirs + store + scheduler
    GW-->>Plugin: /health ok or degraded
  end
```

## 外部事件到处理器

| 事件 | 处理器 | 第一处断点或日志 |
| --- | --- | --- |
| 用户提交 prompt | Codex/Claude hook `prefetch` -> `hook.py:_prefetch_args()` | `TDAI_HOOK_LOG` JSONL `phase=prepared` |
| turn 完成 | Codex/Claude hook `sync-turn` -> `hook.py:_sync_turn_args()` | `TDAI_HOOK_LOG` JSONL + Gateway `Capture completed` |
| agent 主动查记忆 | MCP `protocol.py:McpServer.handle_message()` | `tools/call` 分支 |
| Gateway 收请求 | `server.ts:handleRequest()` | `Request error [METHOD path]` 或 route-specific logs |
| Core recall | `tdai-core.ts:handleBeforeRecall()` | `[memory-tdai] [recall] Recall timing` |
| Core capture | `tdai-core.ts:handleTurnCommitted()` | `[memory-tdai] [capture] L0 recorded` |
| L1 抽取 | `pipeline-manager.ts:runL1()` + `pipeline-factory.ts:createL1Runner()` | `[pipeline] L1 running`, `[l1] Processing ...` |
| L2/L3 | `pipeline-manager.ts:runL2()/runL3()` | `[L2] Extraction complete`, `[L3] Persona generation succeeded` |

## 项目元信息

| 文件 | 用途 |
| --- | --- |
| `package.json` | Node/TypeScript package, scripts, runtime deps。 |
| `index.ts` | OpenClaw plugin root。 |
| `src/gateway/server.ts` | Gateway HTTP server root。 |
| `packages/tdai-memory-mcp/pyproject.toml` | MCP Python package。 |
| `packages/tdai-memory-cli/pyproject.toml` | CLI/hook Python package。 |
| `plugins/tdai-memory/.codex-plugin/plugin.json` | Codex plugin manifest。 |
| `plugins/tdai-memory-claude-code/.claude-plugin/plugin.json` | Claude Code plugin manifest。 |
