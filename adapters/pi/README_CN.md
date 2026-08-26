# Pi

> agentSource: `pi` | 协议: OpenAI Chat Completions | Session Init: Header 预选（无交互 Form）
>
> 英文文档：[README.md](README.md)

---

## 1. 客户端接入配置

Pi 通过 `~/.pi/agent/models.json` 中的自定义 Provider 接入 MemoryProxy，
不需要插件、Hook、MCP Server，也不需要修改 Pi 源码。

将 [`models.example.json`](models.example.json) 合并到 `models.json`，然后替换：

- `<space-id>`：Memory 实例 ID；
- `<upstream-model-id>`：MemoryProxy 后端配置的模型 ID。

设置示例配置引用的环境变量：

```bash
export TDAI_MEMORY_USER_KEY='<sk-mem 用户密钥>'
export TDAI_MEMORY_TEAM_ID='<team-id>'
export TDAI_MEMORY_AGENT_ID='<agent-id>'
export TDAI_MEMORY_TASK_ID='<task-id>'
```

PowerShell：

```powershell
$env:TDAI_MEMORY_USER_KEY = '<sk-mem 用户密钥>'
$env:TDAI_MEMORY_TEAM_ID = '<team-id>'
$env:TDAI_MEMORY_AGENT_ID = '<agent-id>'
$env:TDAI_MEMORY_TASK_ID = '<task-id>'
```

字段说明：

- `baseUrl` — Proxy 地址 + `/pi/<spaceId>/v1`；
- `api` — 必须为 `"openai-completions"`；
- `apiKey` — 业务用户的 `sk-mem-...` 用户密钥；
- `headers` — 无交互注册所需的 Team、Agent、Task 预选值；
- `compat` — 启用 Pi 原生的逐会话 `x-session-id` 请求头；
- `models[].id` — 必须与 MemoryProxy 上游支持的模型 ID 匹配。

启动 MemoryProxy 后，在 Pi 的模型选择器中选择
`tdai-memory/<upstream-model-id>`。

请求路径：`POST /pi/:spaceId/v1/chat/completions`。

---

## 2. Session ID

| 优先级 | Header | 来源 |
|---|---|---|
| 1 | `x-conversation-id` | 可选 wrapper 或上层代理 |
| 2 | `x-session-id` | Pi 原生 session affinity |

示例配置启用：

```json
{
  "sendSessionAffinityHeaders": true,
  "sessionAffinityFormat": "openrouter"
}
```

Pi 随后会把当前运行时 Session ID 写入 `x-session-id`。MemoryProxy 已将该请求头
作为会话身份，因此新建、恢复和并行 Pi 会话都不需要自定义 Header Hook。

---

## 3. Session Init（会话初始化）

### 核心差异：纯 Header 预选，无交互 Form

Pi 没有可供 MemoryProxy 调用的内置问答工具，因此 Session 注册依赖 Provider Header：

| Header | 说明 | 必填 |
|---|---|---|
| `x-team-id` | Team ID | 是 |
| `x-agent-id` | Agent ID | 是 |
| `x-task-id` | Task ID | 是 |

处理逻辑：

- 三个 ID 齐全，且属于当前认证用户可见资产 → 直接注册 Session 并启用记忆；
- `x-session-id` 已有有效 binding → 恢复 binding，正常执行记忆链路；
- 预选缺失、不完整或无效 → 当前请求直接透传，不执行注入；
- 透传决定只对当前请求有效，不会为整个 Pi Session 持久化 bypass。

MemoryProxy 必须启用 `sessionInit.enabled` 和
`sessionInit.headerAutoSelect.enabled`；默认 Header 名称已与示例一致。

---

## 4. 请求分类

Pi 的主 Agent Loop 和内部摘要共用同一个 Chat Completions Provider，适配器按下表分流：

| 请求 | 分类 | Memory 副作用 |
|---|---|---|
| 普通对话 | `main` | Session 注册后启用 |
| Tool Result 轮次 | `main` | binding 恢复后启用 |
| 自动压缩 | `auxiliary` | 禁用 |
| Branch Summary | `auxiliary` | 禁用 |
| 未知或部分匹配 | `main` | 保守兜底 |

辅助请求必须完整命中 Pi `0.84.2` 摘要 envelope：恰好两条消息、已知摘要
System Prompt、User `<conversation>` 包裹，并且没有工具。任何单一弱信号都不会
关闭记忆链路。

---

## 5. 用户文本提取

Pi 的消息内容可能是字符串，也可能是 OpenAI text content parts。适配器对两种形态
复用共享提取器；严格的辅助请求门禁会阻止合成的 `<conversation>` 摘要输入进入
L0 或 Skill，而文本提取器不会仅凭这一项弱信号丢弃真人输入。

---

## 6. 注入 Profile

Pi 与 CodeBuddy、dsh、OpenCode 共用 `handleChatCompletions`。Session 注册后，
MemoryProxy 将标准内容块注入 System Message：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

binding 恢复、L0 回流、Skill 提取、Knowledge 注入、鉴权、可观测和 Credit 上报
均复用现有共享链路。

---

## 7. 特殊行为

- **共享 Handler**：Pi 使用通用 OpenAI Chat Completions Handler，不新增 `piHandler.ts`；
- **一等归因**：路由 `/pi/` 设置 `agentSource=pi`，用于 Session Key 和 Telemetry；
- **不伪造工具**：MemoryProxy 不会向 Pi 返回无法执行的 Session Init 工具；
- **请求级 fail-open**：资产选择不可用时，不会污染后续请求状态；
- **Session Reset**：修改静态资产 Header 后新建 Pi 会话；不支持交互式 `mem:session-reset`。

---

## 8. 环境变量

| 变量 | 用途 |
|---|---|
| `TDAI_MEMORY_USER_KEY` | Memory 用户鉴权密钥 |
| `TDAI_MEMORY_TEAM_ID` | Header 预选 Team ID |
| `TDAI_MEMORY_AGENT_ID` | Header 预选 Agent ID |
| `TDAI_MEMORY_TASK_ID` | Header 预选 Task ID |

Pi 加载 `models.json` 时会解析 `$VARIABLE_NAME`。不要提交包含明文凭据的实际配置。

---

## 9. 已知限制

- 一个 Provider 条目的 Team、Agent、Task ID 是静态值；切换资产时需要新增或修改
  Provider 条目；
- Pi `0.84.2` 没有内置交互式资产选择工具，因此无法在当前会话内补全不完整预选；
- 摘要分类基于 Pi `0.84.2` 验证；未来 Pi 请求形态变化时先按安全的 `main` 路径处理，
  待验证后再扩展分类。

---

## 10. 常见问题

**Q: 只修改 `baseUrl` 就够了吗？**

A: 不够。该方案是零代码接入，不是零配置接入；必须保留示例中的 `compat` 会话设置
和三个资产 Header。

**Q: 为什么使用 `sessionAffinityFormat: "openrouter"`？**

A: 该格式会发送 MemoryProxy 已支持的 `x-session-id`，无需扩展 Hook 即可隔离每个
Pi 运行时会话。

**Q: 资产 ID 配错会怎样？**

A: MemoryProxy 会根据当前用户可见资产验证 ID。当前请求不带记忆直接透传，且不会
写入持久化 bypass。

**Q: `models.json` 中的 cost 可以填 0 吗？**

A: 可以。这些字段是 Pi 客户端侧模型元数据；MemoryProxy 独立完成上游用量计算。

---

## 11. 当前验证状态

- Pi `0.84.2` 使用 `--no-extensions` 的纯配置冒烟验证通过；
- 真实请求包含动态 `x-session-id` 和三个资产预选 Header；
- 路由规范化、Credit 归因、Provider 配置和请求分类测试通过。
