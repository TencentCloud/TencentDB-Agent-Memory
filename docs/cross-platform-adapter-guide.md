# Cross-Platform Adapter Guide

## 为任何平台集成 TDAI 四层记忆系统

---

**目录**

- [1. 架构总览](#1-架构总览)
- [2. 核心概念](#2-核心概念)
- [3. 适配步骤（标准流程）](#3-适配步骤标准流程)
- [4. Claude Code 适配层使用指南](#4-claude-code-适配层使用指南)
- [5. 其他平台适配参考](#5-其他平台适配参考)
  - [5.1 Codex (VS Code 扩展)](#51-codex-vs-code-扩展)
  - [5.2 Dify (低代码 AI 平台)](#52-dify-低代码-ai-平台)
  - [5.3 Cursor / Windsurf](#53-cursor--windsurf)
  - [5.4 自定义 CLI 工具](#54-自定义-cli-工具)
- [6. 最佳实践](#6-最佳实践)
- [7. 故障排查](#7-故障排查)

---

## 1. 架构总览

### 推荐路径：Gateway 模式（自 PR #316 起）

```
┌──────────────────────────────────────────────────────────────┐
│              你的平台 (Your Platform)                         │
│  ┌──────────┐  ┌──────────┐  ┌─────────────┐                │
│  │ 事件钩子  │  │ 工具注册  │  │ LLM 推理    │                │
│  └─────┬────┘  └─────┬────┘  └──────┬──────┘                │
└────────┼──────────────┼──────────────┼───────────────────────┘
         │ 调用          │ 转发          │
         ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────┐
│  GatewayMemoryClient — 轻量 HTTP 客户端                       │
│  (src/adapters/gateway-client/index.ts)                      │
│                                                              │
│  recall()  capture()  searchMemories()  searchConversations()│
│  endSession()                                                │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP
┌──────────────────────────┴───────────────────────────────────┐
│  TDAI Gateway (daemon 进程)                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  TdaiCore / HostAdapter / LLMRunnerFactory               │ │
│  │  VectorStore / EmbeddingService / PipelineManager        │ │
│  │  SQLite or TCVDB                                        │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 可选路径：MemoryPlugin + MemoryPlatformAdapter（旧模式）

适用于需要进程内集成的场景，通过 `src/sdk/` 实现：

```
你的平台 → MemoryPlatformAdapter → MemoryPlugin → GatewayMemoryClient → Gateway HTTP
```

`MemoryPlugin` 类内部已使用 `GatewayMemoryClient`，不再内嵌 TdaiCore。

**核心原则：分层隔离**

| 层 | 职责 | 通信方式 |
|----|------|----------|
| **GatewayMemoryClient** | HTTP 客户端封装，零依赖 | HTTP POST → Gateway |
| **MemoryPlugin** (SDK) | 高级 API 封装，调用 Gateway | 内部使用 GatewayMemoryClient |
| **TDAI Gateway** | 常驻进程，运行 TdaiCore | 监听 HTTP 端口（默认 :8420） |
| **Platform Adapter** | 平台特定的钩子映射 | 调用 GatewayMemoryClient |

---

## 2. 核心概念

### 2.1 生命周期

```
initialize()
    │
    ├── loadConfig()          从平台读取配置
    ├── resolveDataDir()      确定数据存储路径
    ├── 创建 TdaiCore + 存储后端
    ├── registerTool() × 2   注册 tdai_memory_search / tdai_conversation_search
    └── on("beforePrompt")    订阅 LLM 推理前钩子
    └── on("afterTurn")       订阅 LLM 推理后钩子
    └── on("shutdown")        订阅平台关闭事件

每轮对话:
    beforePrompt → recall()    → 注入记忆上下文 → LLM 推理
    afterTurn    → capture()   → 存储对话 → L1/L2/L3 管线

destroy()
    ├── 关闭调度器、存储、Embedding 服务
    └── 清理缓存
```

### 2.2 核心操作

| 操作 | 触发时机 | 功能 |
|------|---------|------|
| `recall(text, sessionKey)` | LLM 推理前 | 向量搜索 L1 记忆 + L3 画像 → 注入到 prompt |
| `capture(turn)` | LLM 推理后 | 记录 L0 对话 → 调度 L1/L2/L3 提取管线 |
| `searchMemories(params)` | LLM 调用工具 | 按需搜索结构化 L1 记忆 |
| `searchConversations(params)` | LLM 调用工具 | 按需搜索原始 L0 对话 |
| `sessionEnd(sessionKey)` | 会话结束 | 刷出会话级缓冲数据 |

### 2.3 两种集成模式

**模式 A：子进程模式（推荐入门）**
- 每次钩子调用启动一个短生命周期进程
- 适合钩子系统驱动的平台（Claude Code hooks）
- 简单、隔离性好，但每次 init/destroy 有开销

**模式 B：长进程模式（推荐生产）**
- 插件在平台进程中持续运行
- 适合有插件 API 的平台（OpenClaw plugin）
- 无启动开销，缓存可跨轮次共享

---

## 3. 适配步骤（标准流程）

### Step 1：创建适配器目录

```bash
mkdir -p src/adapters/<platform-name>
```

参考现有结构：
```
src/adapters/
├── index.ts                  # 桶导出（添加新适配器的导出）
├── openclaw/                 # OpenClaw 适配器
├── standalone/                # Gateway 适配器
├── gateway-client/           # 通用 Gateway HTTP 客户端
└── <platform-name>/          # ✨ 你的新适配器
    ├── index.ts              # 桶导出
    └── adapter.ts            # 实现平台特定的钩子映射
```

### Step 2：使用 GatewayMemoryClient（推荐方式）

自 PR #316 起，推荐通过 **Gateway HTTP API** 进行集成。这是最简洁的路径：

```typescript
import { GatewayMemoryClient, createGatewayPlatformAdapter }
  from "@tencentdb-agent-memory/memory-tencentdb";

// 1. 创建 HTTP 客户端
const client = new GatewayMemoryClient({
  baseUrl: process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});

// 2. 创建生命周期适配器
const memory = createGatewayPlatformAdapter({
  client,
  platform: "my-platform",
  resolveContext: () => ({
    sessionKey: process.env.MY_SESSION_KEY ?? "default",
    userId: process.env.USER,
  }),
});

// 3. 在钩子中使用
// LLM 推理前：
const recall = await memory.prefetch(userText);

// LLM 推理后：
await memory.captureTurn({
  userText: userText,
  assistantText: response,
  messages: conversation,
});

// 搜索记忆：
const results = await memory.searchMemories({ query: "..." });

// 会话结束：
await memory.endSession();
```

> **注意**：旧版 `MemoryPlatformAdapter` 接口（需实现 `loadConfig()`、`resolveDataDir()` 等方法）已废弃，
> 新平台请使用上方的 Gateway 模式。MemoryPlugin(MemoryPlatformAdapter) 仅在需要进程内集成 TdaiCore
> 的遗留场景中使用。

### Step 3：新增平台工具（通过 MCP）

如果需要向 LLM 暴露记忆搜索工具，推荐通过 **MCP Server** 注册，零代码配置：

```jsonc
// .claude/settings.json（Claude Code）
// .codex/config.toml（Codex CLI）
{
  "mcpServers": {
    "memory-tdai": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"]
    }
  }
}
```

MCP Server 会提供 5 个工具：
- `tdai_recall` — 推理前召回记忆
- `tdai_capture` — 推理后捕获对话
- `tdai_memory_search` — 搜索结构化 L1 记忆
- `tdai_conversation_search` — 搜索原始 L0 对话
- `tdai_session_end` — 结束会话

详见 [MCP 适配器文档](./mcp-adapter.md)。

### Step 4：验证集成

```bash
# 检查 Gateway 健康状态
curl http://127.0.0.1:8420/health

# 手动测试 recall
curl -X POST http://127.0.0.1:8420/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"test","session_key":"my-session"}'

# 查看 SDK 集成测试
npx vitest run src/sdk/plugin.test.ts

---

## 4. Claude Code 适配层使用指南

### 4.1 前置条件

- Node.js >= 18
- 项目已安装 `@tencentdb-agent-memory/memory-tencentdb` 依赖
- Claude Code CLI 已登录并可用

### 4.2 快速安装

```bash
# 在项目目录中安装
npm install @tencentdb-agent-memory/memory-tencentdb

# 自动配置 Claude Code hooks 和 MCP server
npx memory-tdai configure-claude-code
```

或手动编辑 `.claude/settings.json`：

```bash
# 生成配置片段
npx memory-tdai claude-code-generate-config
```

配置片段会自动添加：

```jsonc
// .claude/settings.json
{
  "hooks": {
    "preMessage": [
      {
        "matcher": "*",
        "run": "npx --package @tencentdb-agent-memory/memory-tencentdb memory-tdai claude-code-recall"
      }
    ],
    "postMessage": [
      {
        "matcher": "*",
        "run": "npx --package @tencentdb-agent-memory/memory-tencentdb memory-tdai claude-code-capture"
      }
    ]
  },
  "mcpServers": {
    "memory-tdai": {
      "command": "npx",
      "args": ["--package", "@tencentdb-agent-memory/memory-tencentdb", "memory-tdai", "claude-code-mcp"]
    }
  }
}
```

### 4.3 工作原理

```
每轮 Claude Code 对话:
┌──────────────────────────────────────────────────────────────────────┐
│ 1. 用户输入消息                                                     │
│     │                                                               │
│ 2. preMessage hook 触发                                             │
│     │                                                               │
│ 3. claude-code-recall 脚本运行                                       │
│     ├── ClaudeCodeAdapter() + MemoryPlugin                          │
│     ├── plugin.recall(userText, sessionKey)                         │
│     └── 输出 JSON 上下文 → Claude Code 注入到 prompt                 │
│     │                                                               │
│ 4. LLM 推理 + 生成回复                                               │
│     │                                                               │
│ 5. postMessage hook 触发                                            │
│     │                                                               │
│ 6. claude-code-capture 脚本运行                                      │
│     ├── ClaudeCodeAdapter() + MemoryPlugin                          │
│     └── plugin.capture(turn) → L0 记录 + 调度管线                    │
│                                                                      │
│ 7. 用户可调用 /tdai_memory_search 工具（MCP Server）                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.4 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_TDAI_DATA_DIR` | `.claude/memory-tdai/` | 数据存储目录 |
| `MEMORY_TDAI_CAPTURE_ENABLED` | `true` | 是否启用对话捕获 |
| `MEMORY_TDAI_RECALL_ENABLED` | `true` | 是否启用记忆召回 |
| `MEMORY_TDAI_RECALL_MAX_RESULTS` | `5` | 召回最大结果数 |
| `MEMORY_TDAI_EXTRACTION_ENABLED` | `true` | 是否启用 L1 提取 |
| `MEMORY_TDAI_STORE_BACKEND` | `sqlite` | 存储后端（sqlite 或 tcvdb） |
| `MEMORY_TDAI_LLM_BASE_URL` | — | 独立 LLM 的 API URL（设置后启用独立提取模式） |
| `MEMORY_TDAI_LLM_API_KEY` | — | 独立 LLM 的 API Key |
| `MEMORY_TDAI_LLM_MODEL` | `gpt-4o` | 独立 LLM 的模型名 |
| `MEMORY_TDAI_EMBEDDING_PROVIDER` | `none` | Embedding 服务提供商 |
| `MEMORY_TDAI_EMBEDDING_BASE_URL` | — | Embedding API URL |
| `MEMORY_TDAI_EMBEDDING_API_KEY` | — | Embedding API Key |
| `MEMORY_TDAI_EMBEDDING_MODEL` | — | Embedding 模型名 |
| `MEMORY_TDAI_EMBEDDING_DIMENSIONS` | — | 向量维度 |
| `MEMORY_TDAI_DEBUG` | `false` | 启用调试日志 |

### 4.5 存储后端选择

**SQLite（默认，推荐本地使用）**

```bash
# 默认就是 SQLite，无需额外配置
# 数据存储在 .claude/memory-tdai/ 下
```

- 零外部依赖
- 支持 sqlite-vec 向量搜索
- 适合个人项目和开发环境

**Tencent Cloud VectorDB（生产环境）**

```bash
export MEMORY_TDAI_STORE_BACKEND=tcvdb
export MEMORY_TDAI_TCVDB_URL=http://your-instance:8100
export MEMORY_TDAI_TCVDB_API_KEY=your-key
```

- 可水平扩展
- 支持高并发
- 适合团队共享记忆数据

### 4.6 验证安装

```bash
# 检查 CLI 是否正确安装
npx memory-tdai --help

# 手动触发一次 recall 测试
echo '{"text":"hello world","sessionKey":"test"}' | npx memory-tdai claude-code-recall

# 查看存储目录
ls -la .claude/memory-tdai/
```

---

## 5. 其他平台适配参考

### 5.1 Codex (VS Code 扩展)

**特点**：
- VS Code 扩展运行在 Extension Host 进程中（长进程）
- 可以通过 `vscode.lm.invokeChatParticipant` 注册 Chat Participant
- 没有直接的 pre/post message 钩子，但可以注册 ToolProvider

**适配器示例**：

```typescript
// src/adapters/codex/adapter.ts
import * as vscode from "vscode";
import { MemoryPlugin } from "../../sdk/plugin.js";

export class CodexAdapter implements MemoryPlatformAdapter {
  readonly platform = "codex";
  readonly logger;

  constructor(private context: vscode.ExtensionContext) {
    this.logger = {
      info: (m) => console.log(`[memory-tdai] ${m}`),
      warn: (m) => console.warn(`[memory-tdai] ${m}`),
      error: (m) => console.error(`[memory-tdai] ${m}`),
    };
  }

  loadConfig(): Record<string, unknown> {
    // 从 VS Code workspace configuration 读取
    const cfg = vscode.workspace.getConfiguration("memory-tdai");
    return {
      capture: { enabled: cfg.get<boolean>("captureEnabled", true) },
      recall: { enabled: cfg.get<boolean>("recallEnabled", true) },
      // ...
    };
  }

  resolveDataDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "memory-tdai");
  }

  resolveStandaloneLLM(): ResolvedLLMConfig | null {
    // Codex 可使用自身 LLM，返回 null
    return null;
  }

  registerTool(spec: ToolRegistration): void {
    // Codex 使用 vscode.lm API 注册工具
    // 需要通过 ChatRequestAccess 在 chat participant 中暴露
    // ...
  }

  on(event, handler): void {
    // Codex 没有直接的 pre/post 钩子
    // 需要在 ChatParticipant 的 resolve()/provideCompletion() 中
    // 手动调用 plugin.recall() 和 plugin.capture()
  }
}
```

**差异点**：
| 方面 | Codex | Claude Code | OpenClaw |
|------|-------|-------------|----------|
| 进程模型 | 长进程 (Extension Host) | 子进程 (Hook) | 长进程 (Plugin) |
| 工具注册 | `vscode.lm.registerTool()` | MCP Server | `api.registerTool()` |
| 钩子系统 | ChatParticipant 回调 | preMessage/postMessage | `api.on("event")` |
| 数据目录 | `extensionContext.globalStorageUri` | `.claude/memory-tdai/` | `~/.openclaw/state/memory-tdai` |
| 配置来源 | VS Code settings.json | 环境变量 + `.claude/settings.json` | `openclaw.json` |

### 5.2 Dify (低代码 AI 平台)

**特点**：
- Python 后端 + 前端
- 有 Plugin 机制（Dify Plugin Scaffold）
- 可以通过 Memory 接口实现自定义记忆组件
- 需要 HTTP API 或有 Python SDK

**适配策略**：

```
选项 A：HTTP Gateway 模式（推荐）
  Dify Plugin (Python) ──HTTP──► TDAI Gateway (Node.js) ──► TdaiCore
                                  │ 端口 8420
                                  │ 独立部署或 sidecar

选项 B：纯 Python SDK 模式
  Dify Plugin (Python) ──► Python TdaiClient ──► TdaiCore
                            （需要 Python 版本的 TdaiCore）
```

**选项 A 的适配器**：

```python
# dify-plugin/memory_tdai/provider.py
from dify_plugin import MemoryProvider
from dify_plugin.schema import ToolParameterValue

class TdaiMemoryProvider(MemoryProvider):
    """Dify memory provider via TDAI Gateway."""

    def _get_client(self):
        return TdaiGatewayClient(
            base_url=os.getenv("TDAI_GATEWAY_URL", "http://127.0.0.1:8420"),
            api_key=os.getenv("TDAI_GATEWAY_API_KEY"),
        )

    def get_memory(self, session_id: str) -> list[dict]:
        """获取对话记忆（相当于 recall）。"""
        client = self._get_client()
        return client.recall(query="", session_key=session_id)

    def set_memory(self, session_id: str, messages: list[dict]) -> None:
        """保存对话记忆（相当于 capture）。"""
        client = self._get_client()
        client.capture(messages=messages, session_key=session_id)

    def delete_memory(self, session_id: str) -> None:
        """删除会话记忆。"""
        client = self._get_client()
        client.end_session(session_key=session_id)

    def get_tool_schemas(self) -> list[dict]:
        """注册记忆搜索工具。"""
        return [MEMORY_SEARCH_SCHEMA, CONVERSATION_SEARCH_SCHEMA]
```

**差异点**：
| 方面 | Dify | Claude Code |
|------|------|-------------|
| 语言 | Python | TypeScript |
| 集成方式 | MemoryProvider 接口 | Hook + MCP |
| 通信 | HTTP Gateway | 直接进程内 / HTTP |
| 工具注册 | get_tool_schemas() | MCP Server |
| 单/多租户 | 多租户 SaaS | 单用户 CLI |

### 5.3 Cursor / Windsurf

**特点**：
- 类 VS Code 的 IDE，有 AI 对话功能
- 通常可以通过 VS Code 扩展 API 集成（兼容 VS Code 扩展市场）
- 或利用它们的 `rules` 功能注入系统提示

**适配策略**：

```typescript
// 如果兼容 VS Code 扩展 API → 参考 Codex 方案
// 如果不兼容 → 使用 .cursor/rules 注入 + hooks

// .cursor/rules/memory-tdai.mdc（markdown 格式的规则文件）
---
description: TDAI Memory Integration
globs: *
---

You have access to the TDAI four-layer memory system.
Memories are stored in .cursor/memory-tdai/.

To recall memories: read the files in .cursor/memory-tdai/L1/
To save memories: write to .cursor/memory-tdai/L0/

Available tools:
- tdai_memory_search: Search L1 structured memories
- tdai_conversation_search: Search L0 conversations
```

**差异点**：
| 方面 | Cursor | Claude Code |
|------|--------|-------------|
| 集成方式 | `.cursor/rules` 提示注入 | Hook + MCP |
| 工具注册 | 规则定义（非编程） | MCP Server |
| 数据目录 | `.cursor/memory-tdai/` | `.claude/memory-tdai/` |
| 适用场景 | 轻量集成 | 全功能集成 |

### 5.4 自定义 CLI 工具

**适配器示例**：

```typescript
// src/adapters/custom-cli/adapter.ts
export class CustomCliAdapter implements MemoryPlatformAdapter {
  readonly platform = "custom-cli";
  readonly logger = console;

  loadConfig(): Record<string, unknown> {
    return {
      capture: { enabled: true },
      recall: { enabled: true },
      storeBackend: "sqlite",
      dataDir: process.env.MEMORY_DIR || "./memory-data",
    };
  }

  resolveDataDir(): string {
    return this.loadConfig().dataDir as string;
  }

  resolveStandaloneLLM(): ResolvedLLMConfig | null {
    // 从 config 文件或 env 读取 LLM 配置
    const apiKey = process.env.LLM_API_KEY;
    return apiKey
      ? { baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1", apiKey, model: "gpt-4o" }
      : null;
  }

  registerTool(_spec: ToolRegistration): void {
    // CLI 工具无 LLM 工具调用能力，no-op
  }

  on(_event: string, _handler: Function): void {
    // CLI 工具由用户手动触发操作，no-op
  }
}

// 使用示例
async function main() {
  const adapter = new CustomCliAdapter();
  const plugin = new MemoryPlugin({ adapter });
  await plugin.initialize();

  // 手动操作
  const result = await plugin.recall(userInput, sessionKey);
  console.log("Related memories:", result.prependContext);

  // 使用完后保存
  await plugin.capture({ messages, sessionKey, userText, assistantText });

  await plugin.destroy();
}
```

---

## 5.5 平台对比矩阵

各平台在适配 TDAI 时的主要差异：

| 维度 | Claude Code | Codex | Dify | OpenClaw | Cursor / Windsurf |
|:-----|:------------|:------|:-----|:---------|:------------------|
| **集成模式** | Hook 子进程 + MCP | VS Code Extension 长进程 | Python Plugin | Plugin 长进程 | `.cursor/rules` 提示注入 |
| **语言** | TypeScript | TypeScript | Python | TypeScript | Markdown（规则文件） |
| **进程模型** | 短生命周期子进程<br>(每次钩子调用) | 长进程<br>(Extension Host) | 长进程<br>(Plugin Worker) | 长进程<br>(Plugin 容器) | 无独立进程 |
| **通信路径** | Gateway HTTP | Gateway HTTP / MCP stdio | Gateway HTTP | 进程内 TdaiCore<br>或 Gateway HTTP | 文件读取 |
| **推荐客户端** | `GatewayMemoryClient`<br>或 `MemoryPlugin` | `GatewayMemoryClient`<br>或 MCP Server | Python `httpx` →<br>Gateway HTTP | `OpenClawHostAdapter`<br>或 `GatewayMemoryClient` | 无（文件系统） |
| **Session Key** | `CLAUDE_SESSION_KEY`<br>env var | `vscode.workspace` +<br>`session id` | Dify `conversation_id` | OpenClaw `sessionKey` | Project path |
| **工具注册** | MCP Server 5 tools | MCP Server 或<br>`vscode.lm.registerTool()` | `get_tool_schemas()`<br>Plugin 声明 | `api.registerTool()` | 规则文件定义 |
| **L0/L1 管线** | Gateway 端 | Gateway 端 | Gateway 端 | 进程内或 Gateway 端 | 不适用 |
| **数据目录** | `.claude/memory-tdai/` | `extension.globalStorageUri` | Dify 存储目录 | `~/.openclaw/state/` | `.cursor/memory-tdai/` |
| **配置来源** | `.claude/settings.json`<br>+ 环境变量 | VS Code `settings.json` | Dify 环境变量 | `openclaw.plugin.json` | `.cursor/rules/` |
| **Gateway 鉴权** | `TDAI_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY` | 无需（进程内） | 不适用 |
| **适配器存在** | ✅ `src/adapters/claude-code/` | 🟡 文档示例 | 🟡 文档示例 + MCP | ✅ `src/adapters/openclaw/` | 🟡 文档示例 |

---

## 6. 最佳实践

### 6.1 配置管理

```
✅ 推荐：三层配置优先级
   环境变量（运行时覆盖） > 项目配置文件 > 编译期默认值

❌ 避免：硬编码路径或 API Key
   loadConfig() 内写死路径 → 不可移植
```

### 6.2 错误处理

```
✅ 推荐：优雅降级
   try { await plugin.recall(...) } catch { return {} }
   → 记忆系统不可用时不阻塞主流程

✅ 推荐：使用 plugin.recall() 内置异常处理
   MemoryPlugin.recall() 内部已 try/catch → 返回空对象

❌ 避免：未捕获的异常传播到平台事件循环
```

### 6.3 数据目录管理

```
✅ 推荐
   resolveDataDir() {
     return process.env.MEMORY_DATA_DIR || path.join(platformDataDir, "memory-tdai");
   }

✅ 数据目录内创建规范子目录
   L0/          - 原始对话 JSONL
   L1/          - 结构化记忆 JSONL
   scene_blocks/ - 场景块
   personae/    - 用户画像
   l3_persona/  - L3 画像
   checkpoints/ - 管线检查点

❌ 避免：不同平台共享同一数据目录
```

### 6.4 LLM 策略选择

```
✅ 平台内置 LLM（推荐）
   resolveStandaloneLLM() { return null; }
   → 提取管线使用平台的 LLM
   → 无需额外 API Key，无需跨平台认证
   → 适用于：OpenClaw、Claude Code

✅ 独立 LLM（需要外部 API）
   resolveStandaloneLLM() { return { baseUrl, apiKey, model }; }
   → 提取管线使用独立的 OpenAI-compatible API
   → 独立于平台 LLM 的配额和速率限制
   → 适用于：Gateway、自定义 CLI
```

### 6.5 测试策略

```typescript
// 测试适配器配置解析
describe("MyPlatformAdapter", () => {
  it("loads config from platform source", () => {
    const adapter = new MyPlatformAdapter(mockPlatform);
    const config = adapter.loadConfig();
    expect(config.capture.enabled).toBe(true);
  });

  it("resolves data directory", () => {
    const adapter = new MyPlatformAdapter(mockPlatform);
    expect(adapter.resolveDataDir()).toMatch(/memory-tdai$/);
  });
});

// 集成测试：使用 MemoryPlugin + MockAdapter
// 参见 tests/sdk/plugin.test.ts
```

---

## 7. 故障排查

### 7.1 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| recall 返回空 | Embedding 服务未配置 | 设置 `MEMORY_TDAI_EMBEDDING_*` 或启用 keyword 策略 |
| capture 不执行 | `capture.enabled = false` | 检查配置中的 `capture.enabled` |
| 工具不显示 | `registerTool()` 未正确实现 | 检查 adapter 的 `registerTool` 实现 |
| 启动超慢 | 首次初始化需下载模型 | L1 提取使用独立 LLM 可避免本地模型下载 |
| 内存不足 | sqlite-vec 加载大向量文件 | 减少 `recall.maxResults` 或改用 tcvdb |
| 钩子不触发 | settings.json 语法错误 | 运行 `npx memory-tdai claude-code-generate-config` 重新生成 |

### 7.2 调试模式

```bash
# Claude Code
export MEMORY_TDAI_DEBUG=1
export DEBUG=memory-tdai*

# 所有平台通用的调试 env
export TDAI_DEBUG=1
```

### 7.3 检查数据完整性

```bash
# 查看 L0 对话记录
ls -la .claude/memory-tdai/L0/

# 查看 L1 结构化记忆
ls -la .claude/memory-tdai/L1/

# 查看 pipeline 调度状态
cat .claude/memory-tdai/checkpoints/*.json
```

---

## 附录：文件清单

| 文件 | 用途 |
|------|------|
| [src/sdk/types.ts](../src/sdk/types.ts) | SDK 共享类型定义 |
| [src/sdk/adapter.ts](../src/sdk/adapter.ts) | `MemoryPlatformAdapter` 接口 |
| [src/sdk/plugin.ts](../src/sdk/plugin.ts) | `MemoryPlugin` 核心类 |
| [src/sdk/index.ts](../src/sdk/index.ts) | SDK 桶导出 |
| [src/adapters/claude-code/adapter.ts](../src/adapters/claude-code/adapter.ts) | Claude Code 适配器实现 |
| [src/adapters/claude-code/cli-recall.ts](../src/adapters/claude-code/cli-recall.ts) | Recall CLI 入口 |
| [src/adapters/claude-code/cli-capture.ts](../src/adapters/claude-code/cli-capture.ts) | Capture CLI 入口 |
| [src/core/tdai-core.ts](../src/core/tdai-core.ts) | TdaiCore 核心引擎 |
| [src/core/types.ts](../src/core/types.ts) | `HostAdapter` / `RuntimeContext` 等核心类型 |
| [docs/adapter-sdk-design.md](adapter-sdk-design.md) | SDK 设计文档 + 双平台验证 |
| [docs/cross-platform-adapter-guide.md](cross-platform-adapter-guide.md) | **本文档 —— 跨平台适配指南** |
