# TDAI Cross-Platform Adapter Architecture

## 数据流全景

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI Agent 平台层                                │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ OpenClaw │  │  Hermes  │  │Claude Code│  │ CodeBuddy│  │   Cursor  │ │
│  │ (已有)   │  │ (已有)   │  │ (新增)   │  │ (新增)   │  │  (未来)  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │             │             │             │             │        │
│       │   进程内    │   HTTP      │  MCP stdio  │  MCP stdio  │  MCP   │
└───────┼─────────────┼─────────────┼─────────────┼─────────────┼────────┘
        │             │             │             │             │
        ▼             ▼             ▼             ▼             ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       适配器层 (HostAdapter)                            │
│                                                                       │
│  ┌─────────────────┐  ┌──────────────────────────────────────────┐   │
│  │OpenClawHostAdapter│  │        Gateway (HTTP Server)             │   │
│  │  (进程内, ~117行) │  │  ┌─────────────────────────────────┐   │   │
│  │                   │  │  │  StandaloneHostAdapter (~97行)   │   │   │
│  │  getRuntimeContext│  │  │  + CCHostAdapter (~85行)        │   │   │
│  │  getLogger()      │  │  │  + CodeBuddyHostAdapter (~85行) │   │   │
│  │  getLLMRunner()   │  │  └─────────────────────────────────┘   │   │
│  └────────┬──────────┘  │                    │                    │   │
│           │             │  POST /recall      POST /capture        │   │
│           │             │  POST /search/*    POST /session/end    │   │
│           │             │  GET /health                           │   │
│           │             └────────────────────┬───────────────────┘   │
└───────────┼──────────────────────────────────┼───────────────────────┘
            │                                  │
            ▼                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       TdaiCore (通用记忆引擎)                           │
│                                                                       │
│  handleBeforeRecall()     ──→ L1 结构化记忆召回                        │
│  handleTurnCommitted()    ──→ L0 对话记录 + L1/L2/L3 Pipeline 触发    │
│  searchMemories()         ──→ L1 向量搜索                             │
│  searchConversations()    ──→ L0 对话搜索                             │
│  handleSessionEnd()       ──→ 会话结束 + flush                        │
│                                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ L0 Store │  │ L1 Store │  │ L2 Store │  │ L3 Store │             │
│  │ (对话)   │  │ (记忆)   │  │ (场景)   │  │ (人格)   │             │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
└───────────────────────────────────────────────────────────────────────┘
```

## Claude Code 集成细节

```
Claude Code 会话
     │
     ├─ 用户输入 → CC 自动调用 MCP tool: tdai_recall
     │               │
     │               ▼
     │         cc-mcp-server.ts (JSON-RPC over stdio)
     │               │
     │               ▼
     │         POST /recall → TdaiCore.handleBeforeRecall()
     │               │
     │               ▼
     │         返回相关记忆上下文
     │
     ├─ 用户主动调用 → MCP tool: tdai_memory_search
     │                  MCP tool: tdai_conversation_search
     │
     └─ 会话结束 → CC hook (Stop) → POST /session/end
                   CC hook → POST /capture (异步)
```

## 关键设计决策

### 1. 为什么 HostAdapter 是正确的基础？

`HostAdapter` 已经在 OpenClaw（进程内）和 Gateway（HTTP）两种截然不同的场景下验证通过。它回答三个问题:
- 谁在调用？（RuntimeContext）
- 怎么记日志？（Logger）
- 怎么调 LLM？（LLMRunnerFactory）

### 2. 为什么 MCP 而非进程内集成？

对于 Claude Code 和 CodeBuddy，它们支持 MCP 协议但不暴露进程内 API。MCP stdio 是它们的一等公民集成方式。我们的 MCP server 是纯 JSON-RPC 2.0，零框架依赖，~280 行 TypeScript。

### 3. 为什么不重复 PR #339 的 SDK？

PR #339 在 Gateway HTTP API 上又包了一层 TdaiAdapter ABC + BridgeAdapter + HermesV2Adapter + MCP server。这是"包装器套包装器"的反模式。本项目的做法是直接扩展 HostAdapter，让 `TdaiCore` 是唯一的"引擎"。

## 新平台接入指南

只需 3 步:

1. 实现 `HostAdapter` (~85行)
2. 注册平台工具 (复用 `TDAI_TOOLS`)
3. 映射平台生命周期事件 → TdaiCore 方法

参考实现:
- `src/adapters/claude-code/host-adapter.ts` (85行)
- `src/adapters/codebuddy/host-adapter.ts` (85行)
- `src/adapters/openclaw/host-adapter.ts` (117行，已有)
