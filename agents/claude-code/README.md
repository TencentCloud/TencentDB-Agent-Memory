# Claude Code (CC)

> agentSource: `claude-code` | 协议: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

### 方式一：环境变量

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<业务用户的 sk-mem-... user_key>"
claude --model <PROXY_UPSTREAM_MODEL 里配的上游模型>
```

### 方式二：配置文件 `~/.claude/settings.json`（推荐，持久化）

编辑 `~/.claude/settings.json`，在 `env` 字段中写入：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<业务用户的 sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

配置完成后直接运行 `claude` 即可，CC 启动时会从 `settings.json` 的 `env` 字段加载环境变量。

### 字段说明

- `ANTHROPIC_BASE_URL`：把 CC 的 API 从 anthropic.com 改指到 proxy；路径里的 `default` 是 memory 实例 ID（`x-tdai-service-id`），本地部署固定叫 `default`
- `ANTHROPIC_AUTH_TOKEN`：**业务用户**的 user_key（从面板 "API Key" 页获取；不建议直接使用 admin key）
- `ANTHROPIC_MODEL`：上游模型名（也可以用 `--model` 命令行参数指定）

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task 表单）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→ 转发到上游 LLM。

客户端发出的请求命中 `POST /claude-code/:spaceId/v1/messages`。

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC 每次启动新会话会自动生成 session ID 并随请求发送，无需手动配置。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

CC 使用 **Anthropic 原生 `tool_use`** 发起交互式 Form：

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- 协议: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 状态机

```
team_select → agent_select → task_select → initialized
```

4 步流程：
1. **team_select** — 选择团队
2. **agent_select** — 选择 Agent
3. **task_select** — 选择 Task（含 isDefault 虚拟项可跳过）
4. **initialized** — 注入资产，进入正常对话

### 3.3 分页

CC 的 `AskUserQuestion` tool 有 **2~4 个选项** 的硬限制（Anthropic 协议约束）。  
当选项超过 3 个时，使用分页机制：

- 每页显示 3 个真实选项 + 1 个 "更多→" 翻页项
- 用户选 "更多→" 后返回下一页
- 最后一页无翻页项

### 3.4 Plan Mode / Default Mode

CC **不存在** Default Mode gate 概念。CC 客户端始终支持 tool_use，form 始终可发。

### 3.5 跳过 Session Init

用户在任何一步输入 "跳过" / "skip" / 选 Other 输入 skip 即可跳过该步骤（`SKIP_RE` 正则匹配）。  
跳过后 proxy 透传请求，不注入资产。

---

## 4. 请求分类

CC 有丰富的请求类型区分：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| **main** | 默认 | 完整链路（注入 + 归档 + 埋点） |
| **fork** | `cache_control` marker 位置分析 | 走完整链路（subagent 共用 session_id） |
| **sidequery** | `cache_control` marker + 特定 pattern | 轻量处理 |
| **compact** | 路径后缀 `/compact` | 辅助请求，跳过注入 |
| **title-gen** | 路径后缀 + body 特征 | 辅助请求，跳过注入 |

CC 的 `cache_control` marker 是主请求 vs 辅助请求的核心判据。

---

## 5. 用户文本提取

从 `body.messages` 最后一条 `role: "user"` 消息中提取：
- 取最后一个 `type: "text"` content block
- **跳过** `<system-reminder>` 开头的 block（这些是系统注入不是用户文本）

---

## 6. 注入 Profile

**Markdown 结构**的 system prompt 注入：

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

注入点在 `body.system` 字段（Anthropic 协议 system 独立于 messages）。

---

## 7. 特殊行为

- **resetEpoch**: 支持 `mem:session-reset` 命令，跨节点 stale check
- **Vertex AI relay**: 支持 `x-vertex-ai-session-id` 透传
- **Fork/Subagent**: CC 的 `task` 命令起 subagent 时 session_id 不换，proxy 会把 subagent 和主 agent 累加归档
- **mem 命令**: 完整支持 `mem:sync` / `mem:create-skill` / `mem:session-reset` 等

---

## 8. 归档触发

- 对话超过阈值（token 数 / 轮次）自动触发 `skill/conversation/add`
- 支持 `skill/conversation/force-archive` 手动归档
- 归档数据写入 L0 (TDAI write)

---

## 9. 环境变量

无 CC 专属变量。使用全局 proxy 配置即可：

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC 的上游
```

---

## 10. 常见问题

**Q: CC 会不会因为 form 选项太多卡住？**  
A: 不会，分页机制保证每次最多 4 个选项。但选项很多时用户需要多次翻页。

**Q: CC subagent 的请求会不会重复 session-init？**  
A: 不会。Subagent 复用主 agent 的 session_id，proxy 检测到已 initialized 直接跳过 form。

**Q: CC 的 auxiliary 请求（title-gen / compact）会走注入吗？**  
A: 不会。proxy 识别到辅助请求后直接透传，不做注入/归档。
