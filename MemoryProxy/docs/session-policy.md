# 会话策略：taskMissingPolicy 与 autoConversationId

> 本文档对应的验收标准与自动化测试：`src/__tests__/session-acceptance.test.ts`（ACC-1..ACC-6），
> 全量回归：`npm test`（vitest，本分支 **11 个测试文件 / 102 个用例全过**）。
>
> 说明：基线 `feat/server_team` 上**不含任何测试文件**（上游 v2.0.2-beta.1 删掉了自带用例，
> 基线上 `npm test` 是 `exit 1  No test files found`），因此这 102 个用例**全部**由本 PR 带入，
> 不存在"上游基线 8 个"。

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
| team + agent + 无效 task | 默认按 onMismatch 处理；配 `taskInvalidPolicy: ignore` 则忽略该 task 继续注册 | — |

### 配置（`MemoryProxy/config.example.yaml` → `sessionInit`）

```yaml
sessionInit:
  taskMissingPolicy: reject      # reject（全局默认）/ default / skip
  defaultTaskId: default         # policy=default 时的占位 task_id
  taskInvalidPolicy: mismatch    # mismatch（默认）/ ignore（退回上游 #1131 旧契约）
  # 按客户端覆盖（未列出的客户端走全局策略）：
  taskMissingPolicyByAgent:
    openclaw: skip
    hermes: skip
```

策略语义：

- `skip`：缺 task 不绑定，仅注入 Agent 级记忆；
- `default`：使用 `defaultTaskId` 占位（等效“本次不关联任务”）；
- `reject`：缺 task 则 mismatch（保持旧行为）。

生产默认：全局为 `reject`，仅 OpenClaw / Hermes 放宽为 `skip`；其余客户端
（CC / Codex / WorkBuddy 等）保持严格，避免缺 task 时误绑定团队资产。

### `taskInvalidPolicy`：与上游 #1131 的差异（有意，且可配）

"无效 task"（显式传了 `x-task-id` 但查不到，典型是 stale 或跨 team 复用）与"缺 task"
是两件事。上游 #1131（`feat/task-optional-memory`）**明确规定前者不得阻断注册**：
kernel 把 `taskId` 当可选业务维度（`isolation.ts`），缺失只是把召回放宽到 agent 全域，
静默忽略可以避免存量客户端被表单打断。

本方案默认改为报 mismatch（让用户当场重选），这是**有意的行为变更**，因此做成可配：

| `taskInvalidPolicy` | 行为 | 适用 |
|---|---|---|
| `mismatch`（默认） | `hadMismatch=true`、`mismatchReason="invalid-task"` → 走 `headerAutoSelect.onMismatch` | 希望用户当场纠正 stale task |
| `ignore` | 丢弃该 task、继续注册（`taskId` 保持 undefined，召回放宽到 agent 全域） | 存量部署平滑升级，等价 #1131 旧契约 |

> 升级提示：如果已有客户端会长期回传历史 task_id，把 `taskInvalidPolicy` 设为 `ignore`
> 可保持 #1131 的行为不变；否则它们会从"静默放宽召回"变成"被弹表单 / bypass"。

## 2. autoConversationId：会话 ID 自动管理

### 行为

| 场景 | Proxy 行为 |
|---|---|
| 显式传会话 header | 原样使用，不触发自动生成 |
| 未传 header，检测为新对话 | 自动生成 `auto-<keyId>-<uuid>` 作为会话 ID |
| 未传 header，非新对话（续轮/tool call） | 按 API key 自动关联当前活跃会话 |
| 同一 key 超过 TTL（默认 30 分钟）无活跃 | 旧会话过期，自动开启新会话 |

> 上表描述的是 `autoConversationId.enabled: true` 时的行为。**默认 `false`**：缺失会话 ID 时
> 走 agent profile 兜底键，与合入本 PR 前的行为一致；开启后才会由服务端签发 `auto-*`。

### 配置（`MemoryProxy/config.example.yaml` → `sessionInit`）

```yaml
sessionInit:
  autoConversationId:
    enabled: false           # 默认关；置 true 才由服务端签发 auto-*
    ttlMinutes: 30
    strategy: per-key        # per-key（默认）或 per-key-msg
    deterministic: false
    # deterministicBucketMinutes: 30
    # maxEntries: 2048
    # maxWindowsPerKey: 8
    # maxWindowsTotal: 4096
```

策略对比：

| 策略 | 适用场景 | 会话划分 |
|---|---|---|
| `per-key` | 单窗口客户端 | 同一 key 共享一个活跃会话 |
| `per-key-msg` | 多窗口并行 | 按“首条用户消息指纹”（sha256）区分，每 key 最多 8 个活跃窗口 |

实现边界（单节点）：进程内 Map + TTL 惰性清理 + 容量上限（2048 条）；
**多节点部署需换成 Redis**，接口已收敛在 `resolveOrCreateSessionId`。

显式会话 header 始终优先，自动生成只在缺失时触发 → 完全向后兼容。

### 多实例部署：`TDAI_SESSION_SIGNING_KEY` 必须共享

`auto-*` 会话 ID 带 HMAC 签名（`auto-<签名>-<uuid>`），签名密钥取自环境变量
`TDAI_SESSION_SIGNING_KEY`；**未设置时在每个进程内随机生成**（`randomUUID()`）。

| 部署形态 | 是否必须设置 | 不设置的后果 |
|---|---|---|
| 单实例 / 单进程 | 否（重启后旧 auto-* ID 失效，按缺失重新生成，安全） | 仅多一次会话重建 |
| 多实例 / 多 pod | **必须**，且所有实例同值 | 其他实例签发的 auto-* ID 签名校验失败，被记 `scopeRejected`/`ghostRejected`，会话身份跨实例丢失 |

注意 `deterministic: true` **不能**替代共享密钥：`deriveUuid` 与 `signSessionId` 都以
该密钥做 HMAC，密钥不同则 uuid 与签名都不同，`verifySessionId` 先失败，根本走不到派生
分支。也就是说 deterministic 省掉的是"共享**状态**"，省不掉"共享**密钥**"。

proxy 启动时（`validateAutoConversationConfig`）会在 `autoConversationId.enabled=true`
且未设置该变量时打印告警。生成与挂载方式：

```bash
openssl rand -hex 32        # 生成一次，所有实例复用
export TDAI_SESSION_SIGNING_KEY=<上一步输出>
```

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
`session-store-fence.test.ts` / `session-client-ids.test.ts`）：TTL 滑动窗口、
per-key-msg 窗口上限/过期、容量清理、确定性派生与桶宽校验、指纹稳定性、
跨协议首条用户消息指纹（OpenAI/Anthropic/Responses）、created/resumed 语义，
以及 Responses 路径的显式会话 header 提取（集合与优先级见 §4）。

## 4. 可观测性

自动生成会话时输出结构化日志（4 个 handler 经公共 `stages/session-turn.ts` 接入）：

```text
[session-auto] action=created|resumed conversationId=auto-<keyId>-<uuid> keyId=<keyId> [strategy=per-key|per-key-msg]
```

可用于排查“这条请求为什么进了这个会话”。

> **E2E 发现的真实缺陷（已修复）**：Responses 路径（codex / workbuddy）的会话 ID 提取
> 原先只认 `session-id` header 与 `client_metadata.session_id`，**忽略 `x-conversation-id`**，
> 导致这两个客户端的显式会话 header 失效、autoConversationId 错误接管（`session-acceptance.test.ts`
> 的 ACC-4 只覆盖 `resolveOrCreateSessionId`，未覆盖 wire 侧的提取，因此单测当时未暴露）。
> 修复后 `session/client-ids.ts::extractResponsesSessionId` 的取值顺序为
> `session-id` > `x-conversation-id` > `x-session-id` > `x-chat-id` > `x-thread-id`，
> 全部缺失时退回 `client_metadata.session_id`；header 名大小写不敏感。
> 其中 `x-conversation-id` > `x-session-id` > `x-chat-id` > `x-thread-id` 这一段与
> chat / anthropic 路径（`session-key.ts::resolveConversationId`）**同集合、同优先级**
> ——ACC-4 要求对齐的正是这一段，`x-conversation-id` 在两侧都生效。
> 两条路径**并非完全同集合**：Responses 路径多一个 `session-id`（Codex 历史口径），
> chat / anthropic 路径多 `x-claude-code-session-id` / `x-deepseek-harness-session-id`
> 两个客户端专有头；这是刻意的按客户端分族，完整口径见
> `docs/design/session-isolation-design.md` §3.1 的两路径对照表。
> `session-client-ids.test.ts` 的 10 个用例覆盖上述顺序、回退与两条路径的集合差异，
> `session-policy-e2e.sh` 的 ACC-4 步骤在真机上验证"带 `x-conversation-id` 的请求
> 不再产生 `[session-auto]` 日志"。

## 5. 端到端冒烟脚本

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

## 6. 手动端到端验证步骤（备选，脚本自动化后可不做）

1. 起代理：`npm run start:config`（需 Node v22）；
2. 用 OpenClaw/Hermes 风格请求（仅 `x-team-id + x-agent-id`，无会话头）打
   `/hermes/default/v1/chat/completions` → 返回正常、日志出现 `[session-auto] generated ...`；
3. 同 key 第二请求（仍无会话头）→ 日志不再生成新 ID（续接同一会话）；
4. 等 TTL 后再请求 → 生成新 ID；
5. 显式带 `x-conversation-id` 的旧客户端 → 行为不变（日志无 `[session-auto]`）。

## 7. 任意 Agent 接入（隔离层 Agent 无关）

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
