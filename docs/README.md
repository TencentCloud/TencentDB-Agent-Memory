# Cross-Platform Adapters for TencentDB-Agent-Memory

## 总览

本项目为 TencentDB-Agent-Memory 提供跨平台适配层，让 Claude Code、CodeBuddy、Hermes 等 AI Agent 平台能够使用 TDAI 四层记忆引擎。

与现有 PR (#323, #339, #359) 的关键区别：**复用项目原生 HostAdapter 模式，而非额外抽象层**。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                      TdaiCore (通用引擎)                      │
│           recall | capture | search | sessionEnd             │
├──────────────────────────────────────────────────────────────┤
│                  HostAdapter (抽象接口)                        │
│        getRuntimeContext() | getLogger() | getLLMRunner()    │
├──────────────┬──────────────┬───────────────┬───────────────┤
│ OpenClaw     │ Hermes       │ Claude Code   │ CodeBuddy     │
│ HostAdapter  │ Provider     │ HostAdapter   │ HostAdapter   │
│ (已有,117行)  │ (增强,150行)  │ (新增,85行)    │ (新增,85行)    │
└──────────────┴──────────────┴───────────────┴───────────────┘
```

## 平台适配器

### 1. Claude Code

**接入方式**: MCP stdio server + CC hooks

- `cc-mcp-server.ts` — 纯 JSON-RPC 2.0 MCP server, 零框架依赖
- 提供 4 个工具: `tdai_memory_search`, `tdai_conversation_search`, `tdai_recall`, `tdai_capture`
- 一行配置即可接入

### 2. CodeBuddy (腾讯 AI IDE)

**接入方式**: MCP stdio server（与 CC 复用同一 server）

- `CodeBuddyHostAdapter` — 实现 HostAdapter 接口
- 支持 CodeBuddy 的 MCP 协议

### 3. Hermes Agent

**接入方式**: 增强已有 `hermes-plugin/memory/memory_tencentdb/`

- 复用已有 `MemoryProvider` 基类
- 增加 `tdai_conversation_search` 工具
- 改进 session 管理

## 平台对比

| 维度 | OpenClaw (已有) | Hermes (增强) | Claude Code (新增) | CodeBuddy (新增) |
|:---|---:|---:|---:|---:|
| 语言 | TypeScript | Python | TypeScript | TypeScript |
| 接入方式 | 进程内 HostAdapter | HTTP Gateway | MCP stdio | MCP stdio |
| 工具数 | 2 | 2 | 4 | 4 |
| 自动 recall | ✅ before_prompt_build | ✅ prefetch | ✅ MCP tool | ✅ MCP tool |
| 自动 capture | ✅ agent_end | ✅ sync_turn | ✅ MCP tool | ✅ MCP tool |
| Session 管理 | ✅ 内置 | ✅ 内置 | ✅ manual | ✅ manual |
| 适配器行数 | 117 | ~150 (改进) | ~85 | ~85 |

## 与其他 PR 的对比

| | PR #323 | PR #339 (gugu) | PR #359 | **本项目** |
|:---|:---|:---|:---|:---|
| 策略 | 平台生命周期优先 | 抽象 SDK 优先 | 平台广度优先 | **原生模式复用** |
| 抽象层 | 共享基础设施 | TdaiAdapter ABC | 独立适配器 | **HostAdapter** |
| 平台数 | 3 | 1 (Bridge) | 6 | **3** |
| MCP | 有 (框架依赖) | 有 (纯 JSON-RPC) | 有 | **有 (纯 JSON-RPC)** |
| 新增代码 | ~2000行 | ~5800行 | ~3000行 | **~800行** |
| 设计理念 | 先验证再抽象 | 先抽象再实现 | 广度覆盖 | **复用已验证模式** |

## 快速开始

### 1. 启动 Gateway

```bash
cd TencentDB-Agent-Memory
pnpm install
pnpm exec tsx src/gateway/server.ts
```

### 2. 配置 Claude Code

将 `claude-settings.example.json` 的内容合并到 `~/.claude/settings.json`。

### 3. 使用

在 Claude Code 对话中直接调用工具:
- "搜索我的长期记忆: 用户喜欢什么编程语言?"
- "回忆关于VLM实验的相关上下文"

## 文件结构

```
tdai-platform-adapters/
├── src/adapters/
│   ├── claude-code/
│   │   ├── cc-mcp-server.ts          # CC MCP server
│   │   ├── host-adapter.ts           # CCHostAdapter
│   │   ├── index.ts                  # barrel export
│   │   └── claude-settings.example.json  # CC 配置示例
│   └── codebuddy/
│       ├── host-adapter.ts           # CodeBuddyHostAdapter
│       └── index.ts                  # barrel export
└── docs/
    └── platform-adapter-comparison.md  # 平台对比文档
```
