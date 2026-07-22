# 在 OpenCode 中使用 TencentDB Agent Memory

OpenCode 通过两条互补通道接入记忆系统：

- OpenCode plugin 负责自动召回、上下文注入、捕获和 session flush。
- 共享 stdio MCP server 为模型提供按需记忆搜索与捕获工具。

两条通道复用同一个 `MemoryTools` implementation，并连接同一个 Gateway。MCP server 是面向模型的 stdio transport；plugin 直接调用 `MemoryTools`，确定性处理 lifecycle。

| OpenCode 生命周期点 | 记忆操作 | 行为 |
|---|---|---|
| `chat.message` | `tdai_memory_recall` | 为当前用户消息召回记忆。 |
| `experimental.chat.system.transform` | 上下文注入 | 将召回内容一次性加入 system context，不修改用户消息或 transcript。 |
| `session.status` 的 `idle`，或旧版 `session.idle` | `tdai_memory_capture` | 捕获最近一个完整的 user/assistant turn。 |
| `session.deleted` | `tdai_session_end` | flush 该 session 已排队的工作。 |

## 安装包并启动 Gateway

在 OpenCode 可以解析 npm plugin 的环境中安装：

```bash
npm install @tencentdb-agent-memory/memory-tencentdb
```

从 TencentDB Agent Memory 源码目录或已有部署启动 Gateway：

```bash
node --import tsx src/gateway/server.ts
```

Gateway 默认监听 `http://127.0.0.1:8420`。如需非默认连接参数，在启动 OpenCode 前导出：

```bash
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
export TDAI_GATEWAY_API_KEY="your-gateway-token"
```

## 配置 plugin 与 MCP server

将 [`integrations/opencode/opencode.json.example`](../integrations/opencode/opencode.json.example) 合并到以下任一位置：

- 项目根目录的 `opencode.json`，仅对当前项目生效。
- `~/.config/opencode/opencode.json`，对所有项目生效。

`plugin` 配置加载 `@tencentdb-agent-memory/memory-tencentdb`，OpenCode 会通过该包的 `./server` export 找到 plugin 构建产物。`memory_tencentdb` MCP 配置使用 `npx --package` 解析并启动包内的 `memory-tencentdb-mcp` 命令，不依赖当前 shell 的 `PATH`。`./opencode` export 仍可供 Node 直接 import，但不应写入 OpenCode 的 `plugin` 数组。

OpenCode 会把未设置的 `{env:VARIABLE}` 替换为空字符串。不使用的环境变量可以从配置中删除，尤其是 `TDAI_GATEWAY_API_KEY`。

检查 MCP 连接：

```bash
opencode mcp list
```

该 server 暴露 `tdai_memory_recall`、`tdai_memory_capture`、`tdai_session_end`、`tdai_memory_search` 和 `tdai_conversation_search`。这些工具供模型按需调用；plugin 会确定性触发自动记忆流程，不依赖模型主动调用工具。

## 配置 adapter 状态目录

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway 地址。 |
| `TDAI_GATEWAY_API_KEY` | 未设置 | 发给 Gateway 的 Bearer token。 |
| `TDAI_OPENCODE_STATE_DIR` | `~/.memory-tencentdb/opencode-adapter` | recall、注入、错误门控和 capture 去重状态。 |

当前一个 Gateway 实例对应一个记忆命名空间；这些 adapter 环境变量不提供用户级命名空间隔离。

状态目录中的短期文件权限为 `0600`。pending 状态与成功 marker 在 24 小时后过期；进程异常停止遗留的 claim 最多 60 秒后可恢复。

## 自动捕获如何选择 turn

session 进入 idle 后，plugin 会通过 OpenCode client 读取消息历史。只有最近一条 assistant message 同时满足以下条件才会捕获：

- 存在完成时间。
- 没有 error。
- 包含非空可见文本。
- `parentID` 能匹配到包含非空可见文本的 user message。

plugin 不捕获 reasoning、tool output、synthetic text、ignored text、被中断回答或未完成回答。如果最新 assistant message 不完整，不会回退捕获更早的 turn。

## 故障时保持 fail-open

Gateway、OpenCode client 或本地状态错误不会阻断 OpenCode：

- recall 失败时保留原始 prompt。
- 注入失败时保留正常 system prompt。
- capture 失败时释放本地 claim，后续 idle 事件可以重试。
- session end 失败只记录日志，不阻止删除 session。
- 重复 message、transform 和 idle 事件通过持久化状态去重。

capture 是 at-least-once 投递。如果 Gateway 已接受 capture，但进程在写入本地 marker 前退出，后续 idle 可能再次提交。重试使用稳定 message ID，便于下游去重。

## 注意 experimental 注入 Hook

OpenCode 当前通过 legacy `experimental.chat.system.transform` Hook 提供 system context 注入能力。plugin 同时兼容当前 `session.status` idle 事件与已 deprecated 的 `session.idle`。

生产 smoke test 应记录实际 OpenCode 版本。未来迁移 OpenCode V2 plugin API 时，需要先找到稳定的 system context 注入替代点。

共享 MCP adapter 的详细说明请查看 [MCP adapter 指南](mcp_CN.md)。