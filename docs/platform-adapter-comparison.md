# 平台适配器选择指南

> 帮助新平台选择最适合的接入方式的决策参考。

## 适配器全景矩阵

| | Claude Code | Codex CLI | Dify | MCP | REST | Standalone |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **语言** | TypeScript | TypeScript | TypeScript | TypeScript | TypeScript | TypeScript |
| **接入方式** | hooks+MCP | hooks+MCP | OpenAPI 插件 | stdio JSON-RPC | HTTP API | 进程内 |
| **Gateway 依赖** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (直连TdaiCore) |
| **自动 Recall** | ✅ | ✅ | ✅ | ✅ (tdai_recall) | ❌ (手动) | ✅ |
| **自动 Capture** | ✅ | ✅ | ✅ | ✅ (tdai_capture) | ❌ (手动) | ✅ |
| **Session 管理** | 自动 | 自动 | 手动 | 手动 | 手动 | 自动 |
| **工具暴露** | MCP tools | MCP tools | OpenAPI spec | MCP tools | REST endpoints | 无 |
| **配置复杂度** | 低 (1行hook) | 低 (1行hook) | 中 (工作流配置) | 中 (stdio config) | 高 (自建客户端) | 低 (直连) |
| **生产就绪度** | ✅ 完整测试 | ✅ 完整测试 | ✅ 完整测试 | ✅ 完整测试 | ✅ 完整测试 | ✅ 完整测试 |

## 按场景选择

### 场景 A：已有 MCP 兼容客户端
→ **MCP 适配器**
- 一行配置接入，支持 Claude Code、Codex CLI、Cursor、Trae、Windsurf、CodeBuddy
- 提供 5 个 MCP tools: recall, capture, memory_search, conversation_search, session_end

### 场景 B：Claude Code 深度集成
→ **Claude Code 适配器**
- hooks 自动 recall/capture，无需手动调用 MCP tools
- MCP tools 仍可用于主动搜索

### 场景 C：Codex CLI 深度集成
→ **Codex Code 适配器**
- hooks 自动 recall/capture，与 Claude Code 适配器互补

### 场景 D：Dify 工作流平台
→ **Dify 适配器**
- 完整的 OpenAPI 插件，含 5 个工具定义
- 工作流节点可直接拖拽使用

### 场景 E：自定义 Agent / 非标准平台
→ **REST 适配器**
- 完整 HTTP API 接入，适合任何能发 HTTP 请求的环境
- 适合 LangGraph、CrewAI、AutoGen 等 Python 生态

### 场景 F：独立部署 / 无 Gateway
→ **Standalone 适配器**
- 进程内直连 TdaiCore，无需额外 Gateway 进程
- 适合单进程部署场景

## 与其他 PR 的方法论对比

### 我们的方法：Gateway 为中心 + 薄适配器

```
每个适配器 = platform hooks/mcp/http ↔ GatewayClient ↔ Gateway HTTP API ↔ TdaiCore
```

**优势**：
- 适配器代码量小（每个 80-150 行），维护成本低
- 共享基础设施（重试/熔断/超时）全员复用，质量一致
- 所有适配器行为一致——同一个 Gateway、同一个 TdaiCore

## 快速开始（按平台）

### Claude Code

```bash
# 1. 启动Gateway
memory-tencentdb-gateway

# 2. 配置 hooks
# 将 integrations/claude-code/hooks.json 复制到项目 .claude/ 目录
```

### Codex CLI

```bash
# 1. 启动Gateway
memory-tencentdb-gateway

# 2. 配置
# 将 integrations/codex/ 内容复制到项目 .codex/ 目录
```

### MCP Client (Claude Code / Cursor / Trae / etc.)

```json
{
  "mcpServers": {
    "tencentdb-memory": {
      "command": "memory-tencentdb-mcp",
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_GATEWAY_API_KEY": "your-key"
      }
    }
  }
}
```

### Dify

1. 将 `src/adapters/dify/dify-openapi.ts` 生成的 OpenAPI spec 导入 Dify 自定义工具
2. 在工作流中拖拽 `tdai_recall` / `tdai_capture` 节点

### REST

```bash
curl -X POST http://127.0.0.1:8420/recall \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "上次讨论的架构方案", "session_key": "my-session"}'
```
