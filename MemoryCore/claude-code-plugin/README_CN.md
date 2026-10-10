# Claude Code 适配器（v3，原生接入）

简体中文 · [English](./README.md)

本目录是 Memory Gateway **`/v3/*`** 的 **Claude Code 客户端适配器**。与 [OpenClaw 客户端适配器](../openclaw-plugin/) 一样，它是纯客户端：不做抽取、索引、场景或人格生成，也**不**把 Claude Code 的模型流量转到代理。Claude Code 仍然直接访问 Anthropic；记忆能力通过 Claude Code 自身的生命周期 Hook 和一个 stdio MCP server 接入，两者都基于 npm TypeScript SDK。

| 项目 | 值 |
|------|----|
| 宿主 | Claude Code `v2.1.196+`（hook 载荷提供 `prompt_id` 与 `transcript_path`） |
| SDK | [`@tencentdb-agent-memory/memory-sdk-ts-v2`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-sdk-ts-v2)（`V3MemoryClient` → `/v3/*`，`teamId` / `agentId` / `userId` 隔离） |
| Hook | `UserPromptSubmit` 召回 · `Stop` 逐回合捕获 · `SessionEnd` 补发剩余 |
| MCP 工具 | `tdai_memory_search`、`tdai_conversation_search`、`tdai_scenario_read`、`tdai_memory_capture`；配置 Knowledge Service 后另有 `tdai_wiki_*` |
| 不包含 | 代理路由、Offload、COS 文件读取 |

何时选它而不是[代理方式](../../agents/claude-code/)：你希望获得记忆，但不想把 Claude Code 的模型流量、密钥和计费转到代理上。何时选代理：你希望零代码接入和服务端注入，且可以接受流量经过代理。

## 架构

```text
Claude Code
  ├─ hooks（每个事件一个进程；~/.claude/settings.json）
  │    UserPromptSubmit → dist/hooks/cli.js → searchAtomic（每会话首次另加 readCore、listScenarios）
  │                        → additionalContext：<user-persona>、<scene-navigation>、<relevant-memories>、工具指引
  │    Stop             → dist/hooks/cli.js → 本回合转录增量 → addConversation（L0）
  │    SessionEnd       → dist/hooks/cli.js → 尚未发送的转录 → addConversation（L0）
  └─ MCP server（stdio；~/.claude.json 或 .mcp.json）
       dist/mcp/stdio.js → tdai_memory_search / tdai_conversation_search / tdai_scenario_read / tdai_memory_capture
                          → tdai_wiki_list / search / pages / read / write（Knowledge Service，可选）
            │
            ▼
       TencentDB Agent Memory Gateway（:8420）  +  Knowledge Service（:8421，可选）
```

## 捕获什么

`Stop` 读取 hook 载荷中 `transcript_path` 指向的会话转录（缺省时按 `<config dir>/projects/<cwd 中非字母数字替换为 "-">/<session_id>.jsonl` 定位），把刚结束的回合作为一次 `addConversation` 发送：prompt、每一次工具调用、每一个工具结果、中间与最终回复。`SessionEnd` 发送尚未发送的部分，例如因后台任务运行而跳过了 Stop 的回合。

- thinking 与图片丢弃。tool_use 转为 assistant 文本 `[tool_use id=… name=… input=…]`（input 最多引用 2000 字符）；tool_result 转为 user 文本 `[tool_result tool_use_id=…] …`（最多 4000 字符）。超过 8192 字符的消息分块；每批最多 100 条。
- 凭证形状的片段（私钥、Bearer token、`sk-…` 密钥、GitHub / GitLab / Slack / AWS / Google / npm token、`password=…` 之类的值）在离开本机前替换为 `[redacted:<kind>]`。工具流量经常带有 env 输出与配置文件。
- 状态目录中的会话 marker 记录最后发送的转录条目。失败的批次不推进 marker，回合也不标记为已捕获，由 `SessionEnd` 补发。resume 后再次结束的会话只发送新增部分。
- 读不到转录时，`Stop` 退回到只发送 prompt 与最终回复；这种回合之后只补发工具流量，不会重复落库。
- 存在 `background_tasks` 或 `session_crons` 时跳过捕获，避免把等待后台工作的停顿当作最终回复。

为何按回合而不是在会话结束时发送：100 条消息的批次要占 Gateway 数秒，而一个会话的 `SessionEnd` 只触发一次，全部留到最后会丢失长会话的尾部。

## 召回什么

每个 prompt 注入该 prompt 的 L1 命中（`<relevant-memories>`）。会话首个 prompt 另加一次稳定内容：L3 人格（`<user-persona>`）、L2 场景索引（`<scene-navigation>`，可用 `tdai_scenario_read` 读取）以及 MCP 工具指引。若所有召回请求都失败，则不注入任何内容，稳定内容在下一个 prompt 重试。

## 快速开始

### 1. 构建

```bash
cd MemoryCore/claude-code-plugin
npm install
npm run build          # → dist/hooks/cli.js, dist/mcp/stdio.js
npm test
```

### 2. 环境变量

在启动 `claude` 的 shell 中设置（或写入 `~/.claude/settings.json` 的 `env` 字段）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Memory Gateway 地址。 |
| `TDAI_GATEWAY_API_KEY`（或 `TDAI_API_KEY`） | `local` | Gateway 的 Bearer token。 |
| `TDAI_SERVICE_ID` | `default` | 记忆实例 id（`x-tdai-service-id`）。 |
| `TDAI_TEAM_ID` / `TDAI_AGENT_ID` / `TDAI_USER_ID` | `default` | v3 隔离三元组，来自面板。 |
| `TDAI_KNOWLEDGE_URL` | 未设置 | Knowledge Service 地址；设置后启用 `tdai_wiki_*` 工具。 |
| `TDAI_KNOWLEDGE_API_KEY` | 回退到 Gateway key | Knowledge Service 的 Bearer token。 |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-plugin` | prompt 缓存、捕获标记、转录位置。 |
| `TDAI_RECALL_MAX_RESULTS` | `5` | 每个 prompt 的 L1 命中数。 |
| `TDAI_RECALL_PERSONA` / `TDAI_RECALL_SCENE_NAV` | `on` | 设为 `off` 时首个 prompt 不注入人格 / 场景索引。 |
| `TDAI_CAPTURE` | `on` | 设为 `off` 关闭 Stop 与 SessionEnd 的捕获。 |
| `TDAI_STOP_BUDGET_MS` / `TDAI_SESSION_END_BUDGET_MS` | `3500` / `25000` | 转录批次的时间预算；预算只阻止新批次开始。 |
| `TDAI_RECALL_TIMEOUT_MS` / `TDAI_CAPTURE_TIMEOUT_MS` | `3000` / `15000` | 召回与单个捕获批次的 Gateway 超时。 |

### 3. Hook

把 [`integrations/hooks.json`](./integrations/hooks.json) 合并到 `~/.claude/settings.json`（全局）或 `.claude/settings.json`（单项目），替换绝对路径。hook 的 timeout（5 秒、15 秒、30 秒）必须覆盖进行中的批次，否则 Gateway 已记录的批次不会写下 marker。在 Claude Code 中用 `/hooks` 检查。

### 4. MCP server

把 [`integrations/mcp.json.example`](./integrations/mcp.json.example) 复制到项目根目录作为 `.mcp.json`，或全局注册：

```bash
claude mcp add --transport stdio --scope user tdai -- \
  node /absolute/path/to/TencentDB-Agent-Memory/MemoryCore/claude-code-plugin/dist/mcp/stdio.js
```

用 `/mcp` 检查。请在 `CLAUDE.md` 中告诉模型应使用哪个 wiki id；适配器不会预设任何 wiki。

### 5. 手动测试 Hook

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","prompt_id":"p1","cwd":"/tmp","prompt":"what is our release flow?"}' \
  | node dist/hooks/cli.js
```

无匹配时输出 `{}`，召回成功时输出带 `hookSpecificOutput.additionalContext` 的 JSON。

## 适配器职责

- Hook 进程只通过状态目录下的文件共享状态（文件名为哈希，权限 0600）。prompt 缓存与捕获标记 24 小时过期；会话 marker 30 天过期。
- 所有路径 fail-open。召回失败返回 `{}`；捕获失败写 stderr 并由后续 hook 重试；MCP server 把 Gateway 错误作为工具错误返回。
- 插件不含任何组织专有内容：wiki id 始终是工具参数，身份来自环境变量。

## 文件

```text
claude-code-plugin/
├── src/
│   ├── config.ts            环境变量 → 配置
│   ├── client.ts            V3MemoryClient 与 Knowledge 客户端工厂
│   ├── format.ts            召回上下文格式化
│   ├── knowledge.ts         Knowledge Service 客户端 + wiki 工具
│   ├── hooks/
│   │   ├── cli.ts           hook 入口（stdin → stdout）
│   │   ├── handler.ts       UserPromptSubmit / Stop / SessionEnd
│   │   ├── recall.ts        searchAtomic + readCore + listScenarios
│   │   ├── capture.ts       转录增量 → addConversation
│   │   ├── transcript.ts    JSONL 解析、规范化、脱敏、分块
│   │   └── state.ts         prompt 缓存、捕获标记、会话 marker
│   └── mcp/
│       ├── server.ts        工具定义
│       └── stdio.ts         MCP 入口
├── __tests__/               vitest
├── integrations/            hooks.json、mcp.json.example
└── README.md / README_CN.md
```
