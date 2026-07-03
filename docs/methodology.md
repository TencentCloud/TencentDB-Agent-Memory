# TDAI 跨平台适配器 — 使用说明

## 一、相对于原本项目的提升

原本 TencentDB-Agent-Memory 只支持两个平台：

| 原本支持 | 接入方式 |
|:---|:---|
| OpenClaw | TypeScript 进程内插件 |
| Hermes Agent | Python MemoryProvider → HTTP Gateway |

**本项目新增**：

| 新增平台 | 接入方式 | 代码量 |
|:---|:---|:---|
| Claude Code | MCP stdio server + HostAdapter | 425行 server + 85行 adapter |
| CodeBuddy (腾讯 AI IDE) | MCP stdio server + HostAdapter | 85行 adapter |
| 任意 MCP 平台 (Cursor, Trae等) | 复用同一 MCP server | 0行 |

**新增基础设施**：
- `src/adapters/shared/` — 统一的平台适配器接口和工具定义，新平台接入有标准可循
- `docs/INTEGRATION.md` — 三步接入指南
- `docs/methodology.md` — 方法文档

## 二、快速开始

### 1. 启动 TDAI Gateway

```bash
cd TencentDB-Agent-Memory
npm install
npx tsx src/gateway/server.ts
```

Gateway 启动后在 `http://127.0.0.1:8420` 监听。

验证：`curl http://127.0.0.1:8420/health` → `{"status":"ok"}`

### 2. 配置 Claude Code

编辑 `~/.claude/settings.json`，添加：

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["tsx", "G:/claude code_workspace/tdai-platform-adapters/src/adapters/claude-code/cc-mcp-server.ts"],
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420"
      }
    }
  }
}
```

重启 Claude Code，即可使用 4 个记忆工具。

### 3. 配置 CodeBuddy

```bash
codebuddy mcp add --scope user tdai_memory -- npx tsx "G:/claude code_workspace/tdai-platform-adapters/src/adapters/claude-code/cc-mcp-server.ts"
```

### 4. 使用

CC 或 CodeBuddy 对话中直接调用：

```
"搜索我的长期记忆：我之前做VLM实验用的什么模型？"
→ MCP tool: tdai_memory_search(query="VLM实验 模型")

"回忆关于GRPO训练的相关上下文"
→ MCP tool: tdai_recall(query="GRPO训练")

"保存这一段对话到长期记忆"
→ MCP tool: tdai_capture(user_content="...", assistant_content="...")
```

## 三、可用工具

| 工具 | 功能 | 参数 |
|:---|:---|:---|
| `tdai_memory_search` | 搜索结构化记忆 (L1) | query, limit, type, scene |
| `tdai_conversation_search` | 搜索原始对话 (L0) | query, limit, session_key |
| `tdai_recall` | 主动召回记忆上下文 | query, session_key |
| `tdai_capture` | 保存对话到记忆 | user_content, assistant_content, session_key |

## 四、跨平台效果

```
Hermes 写入一段对话 → Gateway 存储
Claude Code 搜索 → 召回 Hermes 写入的内容
CodeBuddy 搜索 → 召回同一份内容

三个平台共享一个记忆库，无需同时打开。
```

## 五、环境变量

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway 地址 |
| `TDAI_GATEWAY_API_KEY` | (空) | API 密钥（生产环境必设） |

## 六、扩展到新平台

如果你的 Agent 平台支持 MCP，直接复用 `cc-mcp-server.ts`（零代码）。

如果不支持 MCP，参考 `src/adapters/claude-code/host-adapter.ts`，实现 `HostAdapter` 接口（~85行），然后将平台事件映射到 `TdaiCore` 方法。
