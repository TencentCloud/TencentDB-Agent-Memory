# Trae 适配指南

本指南介绍如何在 Trae 平台上安装和配置 TencentDB Agent Memory，实现对话记忆的自动捕获、提取和召回。

## 目录

- [快速开始](#快速开始)
- [安装步骤](#安装步骤)
- [配置说明](#配置说明)
- [环境变量](#环境变量)
- [验证测试](#验证测试)
- [故障排查](#故障排查)
- [高级配置](#高级配置)

## 快速开始

**前置要求:**
- Trae IDE (字节系 AI IDE)
- Node.js >= 22.16.0
- 已安装 `@tencentdb-agent-memory/memory-tencentdb` 包

**三步启用记忆:**

1. 安装依赖包
2. 配置 Trae hooks 和 MCP
3. 设置环境变量并验证

```bash
# 1. 安装包
npm install @tencentdb-agent-memory/memory-tencentdb

# 2. 配置环境变量
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
export TDAI_GATEWAY_API_KEY="your-api-key"

# 3. 验证连接
curl http://127.0.0.1:8420/health
```

## 安装步骤

### 步骤 1: 安装插件包

在项目根目录安装 TencentDB Agent Memory:

```bash
npm install @tencentdb-agent-memory/memory-tencentdb
```

### 步骤 2: 配置 Trae Hooks

创建或编辑 `.trae/hooks.json` 文件：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "node ${TRAE_PLUGIN_DIR}/node_modules/@tencentdb-agent-memory/memory-tencentdb/trae-plugin/scripts/memory-hook.mjs",
        "args": ["SessionStart"]
      }
    ],
    "UserPromptSubmit": [
      {
        "command": "node ${TRAE_PLUGIN_DIR}/node_modules/@tencentdb-agent-memory/memory-tencentdb/trae-plugin/scripts/memory-hook.mjs",
        "args": ["UserPromptSubmit"]
      }
    ],
    "Stop": [
      {
        "command": "node ${TRAE_PLUGIN_DIR}/node_modules/@tencentdb-agent-memory/memory-tencentdb/trae-plugin/scripts/memory-hook.mjs",
        "args": ["Stop"]
      }
    ],
    "SessionEnd": [
      {
        "command": "node ${TRAE_PLUGIN_DIR}/node_modules/@tencentdb-agent-memory/memory-tencentdb/trae-plugin/scripts/memory-hook.mjs",
        "args": ["SessionEnd"]
      }
    ]
  }
}
```

### 步骤 3: 配置 MCP Server

创建或编辑 `.trae/mcp.json` 文件：

```json
{
  "mcpServers": {
    "tdai": {
      "command": "memory-tencentdb-trae-mcp",
      "env": {
        "TDAI_GATEWAY_URL": "${TDAI_GATEWAY_URL}",
        "TDAI_GATEWAY_API_KEY": "${TDAI_GATEWAY_API_KEY}"
      }
    }
  }
}
```

### 步骤 4: 启用 Claude Code Hooks 兼容

Trae 内置「导入 Claude Code hooks」开关，确保已启用此功能以获得最佳兼容性。

## 配置说明

### Gateway 连接配置

Trae 通过 HTTP 方式连接到 TencentDB Gateway，需要指定 Gateway 地址和认证信息。

```bash
# Gateway 地址 (必需)
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"

# API 密钥 (可选，如 Gateway 启用了认证)
export TDAI_GATEWAY_API_KEY="your-secret-key"

# 超时设置 (可选，默认 10000ms)
export TDAI_GATEWAY_TIMEOUT_MS="10000"
```

### Trae 插件目录

设置 `TRAE_PLUGIN_DIR` 环境变量指向项目根目录：

```bash
export TRAE_PLUGIN_DIR="/path/to/your/project"
```

## 环境变量

| 变量名 | 必需 | 默认值 | 说明 |
|--------|------|--------|------|
| `TDAI_GATEWAY_URL` | ✅ | `http://127.0.0.1:8420` | TencentDB Gateway 地址 |
| `TDAI_GATEWAY_API_KEY` | ❌ | _(无)_ | Gateway API 密钥 |
| `TDAI_GATEWAY_TIMEOUT_MS` | ❌ | `10000` | HTTP 请求超时(毫秒) |
| `TRAE_PLUGIN_DIR` | ❌ | `process.cwd()` | 项目根目录路径 |
| `TRAE_SESSION_KEY` | ❌ | `trae-default` | 会话标识符 |

## 验证测试

### 1. Gateway 连接测试

```bash
curl http://127.0.0.1:8420/health
```

预期响应:
```json
{"status":"ok"}
```

### 2. Hooks 功能测试

在 Trae 中发起一次对话，观察是否触发记忆捕获：

```bash
# 检查 hooks 日志
tail -f ~/.trae/hooks.log
```

应该看到类似输出：
```
[tdai-bridge] recall called with query: "how do I implement X"
[tdai-bridge] capture called for session: trae-session-123
```

### 3. MCP 工具测试

Trae 的 MCP server 提供 5 个工具，可以在 Trae 中手动调用测试：

- `tdai_recall`: 召回相关记忆
- `tdai_capture`: 捕获当前对话
- `tdai_memory_search`: 搜索记忆内容
- `tdai_conversation_search`: 搜索历史对话
- `tdai_session_end`: 结束会话

### 4. 端到端测试

在 Trae 中进行完整对话流程：

1. **第一轮对话**: "帮我实现一个快速排序算法"
2. **第二轮对话**: "我刚才问的是什么问题？"  
   - 预期: Agent 能正确回答第一轮的问题
3. **第三轮对话**: 调用 `tdai_memory_search` 工具搜索"排序"
   - 预期: 能检索到第一轮对话的内容

## 故障排查

### 问题 1: Gateway 连接失败

**症状**: `curl: (7) Failed to connect to 127.0.0.1 port 8420`

**解决方案**:
1. 检查 Gateway 是否启动: `ps aux | grep gateway`
2. 启动 Gateway: `npx tsx src/gateway/server.ts`
3. 验证端口占用: `netstat -an | grep 8420`

### 问题 2: Hooks 不触发

**症状**: 对话中没有看到记忆注入

**解决方案**:
1. 检查 `.trae/hooks.json` 路径是否正确
2. 验证 `TRAE_PLUGIN_DIR` 环境变量
3. 启用 Trae 的「导入 Claude Code hooks」开关
4. 检查 hooks 日志: `cat ~/.trae/hooks.log`

### 问题 3: MCP 工具不可用

**症状**: 在 Trae 中看不到 `tdai_*` 工具

**解决方案**:
1. 检查 `.trae/mcp.json` 配置
2. 验证 MCP bin 是否注册: `which memory-tencentdb-trae-mcp`
3. 重新构建项目: `npm run build`
4. 重启 Trae IDE

### 问题 4: 记忆召回为空

**症状**: `additionalContext` 始终为空

**解决方案**:
1. 检查 Gateway 是否正常: `curl http://127.0.0.1:8420/health`
2. 验证 `TDAI_GATEWAY_API_KEY` 是否正确
3. 检查记忆是否已捕获: 查看数据库或日志
4. 调试 `TdaiBridge` 缓存: 临时禁用缓存测试

## 高级配置

### 自定义 Retry 策略

`TdaiBridge` 支持自定义重试策略，通过环境变量调整：

```bash
# 重试次数 (默认 3)
export TDAI_BRIDGE_RETRY_ATTEMPTS="5"

# 基础延迟毫秒 (默认 200)
export TDAI_BRIDGE_RETRY_BASE_MS="100"

# Recall 缓存容量 (默认 256)
export TDAI_BRIDGE_CACHE_MAX="512"
```

### 调整 Recall 注入上限

修改 `additionalContext` 最大字符数（默认 4000）：

```bash
export TDAI_RECALL_MAX_CHARS="6000"
```

### 输入消毒参数

调整输入长度限制，防止 OOM：

```bash
# Query 最大长度 (默认 100000)
export TDAI_SANITIZE_QUERY_MAX="200000"

# Capture 文本最大长度 (默认 1000000)
export TDAI_SANITIZE_CAPTURE_MAX="2000000"
```

### Gateway 安全配置

如果 Gateway 启用了 CORS 和 API Key：

```bash
# CORS 白名单 (如需跨域访问)
export TDAI_CORS_ORIGINS="https://your-domain.com"

# API 认证 (必须与 Gateway 配置一致)
export TDAI_GATEWAY_API_KEY="your-secure-key"
```

## 性能优化

### Recall 缓存优化

`TdaiBridge` 默认启用 recall 会话缓存，使用 SHA-256(query) 作为缓存键。对于相同会话内的重复查询，直接返回缓存结果，显著减少 HTTP 调用。

**监控缓存命中率:**
```bash
# 临时启用调试日志
export TDAI_DEBUG="true"
# 观察缓存命中情况
grep "cache hit" ~/.trae/hooks.log
```

### 并发限制

为避免过载 Gateway，Trae hooks 内置了请求队列机制。如果需要调整并发限制：

```bash
export TDAI_MAX_CONCURRENT_REQUESTS="10"
```

## 与其他平台对比

Trae 适配器相对于其他平台的优势：

| 特性 | Trae | OpenClaw | Hermes | Claude Code |
|------|------|----------|---------|------------|
| 安装复杂度 | 简单 | 最简单 | 中等 | 中等 |
| 配置灵活性 | 高 | 低 | 中 | 高 |
| MCP 支持 | ✅ | ❌ | ❌ | ✅ |
| 缓存优化 | ✅ | ❌ | ❌ | ❌ |
| 重试机制 | ✅ | ✅ | ✅ | ✅ |

更多平台对比细节，请参阅 [平台适配器对比文档](./platform-adapters-comparison.md)。

## 下一步

- 📖 了解更多关于 [记忆分层架构](../README.md#核心技术拒绝平铺走向分层与符号化)
- 🔧 查看 [完整配置参数](../openclaw.plugin.json)
- 🚀 探索 [高级调优选项](../README.md#可调参数)
- 💬 加入 [Agent Memory 微信社群](https://github.com/TencentCloud/TencentDB-Agent-Memory#项目简介) 获取支持

---

**最后更新**: 2026-07-21 (Trae Adapter v0.1.0)
**相关文档**: [平台适配器对比](./platform-adapters-comparison.md) | [主 README](../README.md)