# 会话策略：taskMissingPolicy 与 autoConversationId

> 本文档对应的验收标准与自动化测试：`src/__tests__/session-acceptance.test.ts`（ACC-1..ACC-6），
> 全量回归：`npm test`（vitest，76/76 通过；含上游基线 8 个用例与本 PR 新增 68 个）。

## 背景

CC / Codex / WorkBuddy 等客户端自带会话 ID 和 task 选择，而 OpenClaw / Hermes / DSH 这类
纯 header 客户端此前要求 `x-team-id + x-agent-id + x-task-id` 三元组齐备、且会话 ID 必须
静态写死在配置里。由此带来三个问题：

1. 用户必须先建 Task 才能接入，门槛高；
2. 切换任务要手动改配置；
3. 新对话需手动换 conversation ID，否则继续复用旧会话；tool call 后续请求若丢失
   extra headers，记忆注入直接断档。

本方案在 Proxy 侧把这两件事都“可选化”，向后兼容。

## 1. taskMissingPolicy：task 可选化

### 行为

| 用户传入 | 注册结果 | 注入范围 |
|---|---|---|
| team + agent + task | 绑定 task | Agent 级 + Task 级记忆/skill |
| team + agent（无 task） | 按策略注册，不绑定 task | 仅 Agent 级记忆/skill |
| team + agent + 无效 task | 按 onMismatch 处理（默认 bypass），非静默忽略 | — |

### 配置（`deploy/global-images/.env`）

```bash
PROXY_TASK_MISSING_POLICY=skip            # skip（默认）/ default / reject
PROXY_DEFAULT_TASK_ID=                    # policy=default 时的占位 task_id
# 按客户端覆盖（仅列出的客户端生效，未列出的走全局策略）：
PROXY_TASK_MISSING_POLICY_BY_AGENT_OPENCLAW=skip
PROXY_TASK_MISSING_POLICY_BY_AGENT_HERMES=skip
```

策略语义：

- `skip`（默认/推荐）：缺 task 不绑定，仅注入 Agent 级记忆；
- `default`：使用 `defaultTaskId` 占位（等效“本次不关联任务”）；
- `reject`：缺 task 则 mismatch（保持旧行为）。

生产默认：OpenClaw / Hermes 放宽为 `skip`，其余客户端（CC / Codex / WorkBuddy 等）
保持严格，避免缺 task 时误绑定团队资产。

## 2. autoConversationId：会话 ID 自动管理

### 行为

| 场景 | Proxy 行为 |
|---|---|
| 显式传会话 header | 原样使用，不触发自动生成 |
| 未传 header，检测为新对话 | 自动生成 `auto-<keyId>-<uuid>` 作为会话 ID |
| 未传 header，非新对话（续轮/tool call） | 按 API key 自动关联当前活跃会话 |
| 同一 key 超过 TTL（默认 30 分钟）无活跃 | 旧会话过期，自动开启新会话 |

### 配置

```bash
PROXY_AUTO_CONVERSATION_ENABLED=true      # 默认开
PROXY_AUTO_CONVERSATION_STRATEGY=per-key  # per-key（默认）或 per-key-msg
PROXY_AUTO_CONVERSATION_TTL_MINUTES=30
```

策略对比：

| 策略 | 适用场景 | 会话划分 |
|---|---|---|
| `per-key` | 单窗口客户端 | 同一 key 共享一个活跃会话 |
| `per-key-msg` | 多窗口并行 | 按“首条用户消息指纹”（sha256）区分，每 key 最多 8 个活跃窗口 |

实现边界（单节点）：进程内 Map + TTL 惰性清理 + 容量上限（2048 条）；
**多节点部署需换成 Redis**，接口已收敛在 `resolveOrCreateSessionId`。

显式会话 header 始终优先，自动生成只在缺失时触发 → 完全向后兼容。

## 3. 验收标准 ↔ 自动化用例

| # | 验收标准 | 用例（session-acceptance.test.ts） |
|---|---|---|
| 1 | OpenClaw/Hermes 仅配 x-team-id + x-agent-id → 注册成功，Agent 级记忆注入生效 | ACC-1 |
| 2 | 多轮/tool call 后续请求丢失 extra headers → 记忆注入不中断 | ACC-2 |
| 3 | 30 分钟超时后新请求 → 新 conversation，不污染旧会话 | ACC-3 |
| 4 | 旧配置（显式 4 header）行为不变 | ACC-4 |
| 5 | 无效 x-task-id → 按 onMismatch 处理（非静默忽略） | ACC-5 |
| 6 | per-agent 策略（openclaw/hermes 宽松、其余严格） | ACC-6 |

补充单元覆盖（本 PR 内 `session-isolation.test.ts` / `stages-session.test.ts` /
`session-store-fence.test.ts`）：TTL 滑动窗口、per-key-msg 窗口上限/过期、
容量清理、确定性派生与桶宽校验、指纹稳定性、跨协议首条用户消息指纹
（OpenAI/Anthropic/Responses）、created/resumed 语义、codex 路径显式会话
header 对齐。

## 4. 可观测性

自动生成会话时输出结构化日志（三个 handler 均接入）：

```text
[session-auto] action=created|resumed conversationId=auto-<keyId>-<uuid> keyId=<keyId> [strategy=per-key|per-key-msg]
```

可用于排查“这条请求为什么进了这个会话”。

> **E2E 发现的真实缺陷（已修复）**：`codexHandler.extractCodexSessionId` 原先只认
> `session-id` header / `client_metadata.session_id`，**忽略 `x-conversation-id`**，
> 导致 codex /responses 路径上显式会话 header 失效、autoConversationId 错误接管。
> 已与 `resolveConversationId` 的 header 集合对齐（session-id / x-conversation-id /
> x-session-id / x-chat-id / x-thread-id），并有 6 个单测覆盖。

## 6. 端到端冒烟脚本

`scripts/qa/session-policy-e2e.sh`：对运行中的代理发真实 HTTP 请求，按
`[session-auto]` 容器日志断言：

| 步骤 | 断言 |
|---|---|
| ACC-4 | 显式 x-conversation-id → 无 [session-auto] 日志 |
| ACC-1 | 无会话 header → 恰好 1 条 action=created，提取会话 ID |
| ACC-2 | 同 key 再次无 header → created=0 且出现同 ID 的 resumed |
| ACC-5/6 | 无效/缺失 task → HTTP 200 正常完成（绑定语义由单测覆盖） |

用法：`USER_KEY=sk-mem-xxx ./scripts/qa/session-policy-e2e.sh`（前置：代理已起、可读
`docker logs`、curl 可用）。

## 5. 手动端到端验证步骤（备选，脚本自动化后可不做）

1. 起代理：`npm run start:config`（需 Node v22）；
2. 用 OpenClaw/Hermes 风格请求（仅 `x-team-id + x-agent-id`，无会话头）打
   `/hermes/default/v1/chat/completions` → 返回正常、日志出现 `[session-auto] generated ...`；
3. 同 key 第二请求（仍无会话头）→ 日志不再生成新 ID（续接同一会话）；
4. 等 TTL 后再请求 → 生成新 ID；
5. 显式带 `x-conversation-id` 的旧客户端 → 行为不变（日志无 `[session-auto]`）。

## 6. 任意 Agent 接入（隔离层 Agent 无关）

会话隔离本身不依赖客户端白名单：任何新的 agent 前缀（URL 第一段，如 `/my-agent/...`）
都会被当作独立命名空间，隔离由以下机制保证，与客户端是否“已适配”无关：

- **存储命名空间**：L2a 行主键为 `spaceId:userId:agentSource:sessionId` 四段，未知
  agentSource 与已知客户端同等隔离；L1 键按 `agentSource:sessionKey` 归属校验后才可用。
- **autoConversationId**：无会话头的客户端由 Proxy 代发会话 ID，签名绑定
  `keyId + spaceId + agentSource + scope + 首问指纹`，跨 agent / 跨 space / 跨线程复用一律拒绝。
- **身份直连**：携带 `x-team-id + x-agent-id`（可选 task）的未知客户端直接注册，
  不需要交互式表单；未携带身份头时才按协议形态走交互式表单。
- **接入清单**：新客户端无需改动隔离层；需要做的只是按协议选择表单渲染器
  （Anthropic AskUserQuestion / Chat ask_followup_question / Responses tool 消息），
  这部分与“隔离”正交。

对应自动化用例：`session-isolation.test.ts` 的“任意未知 AgentSource”分组，
以及 `session-acceptance.test.ts` 的 ACC-6（per-agent 全局/按客户端策略）。
