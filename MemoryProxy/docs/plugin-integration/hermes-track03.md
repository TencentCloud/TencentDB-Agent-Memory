# Hermes 交互式 Tools 接入（TRACK 03）

> 状态口径（先读这段，避免误读）：**本 PR 交付的是"接入 + 契约测试 + 调研结论"**，
> 不含端到端真机回归的固化证据，也不含作者对后续演进的完整规划 —— 后者见 §7，
> 由作者在汇报时补写。
>
> 依赖：本分支基于 `feat/server_team` 的当前 tip，按「#1326 → #1226 → #1253 …」的
> 合入顺序。**单独合入时 `npm run typecheck` 会显示基线既有的类型错误**（#1326 修的正
> 是这批），不是本 PR 引入的。

## 1. 结论

Hermes（hermes-agent 0.19.0）的 LLM 出站是标准 OpenAI Chat Completions，
交互式工具 `clarify` 是标准 function-calling 工具。Proxy 不需要为它发明协议，
只需要三件事：

1. 能识别 `agentSource=hermes` 并走正确的适配器；
2. 把含 `clarify` 的请求判为主链路，不被 aux 逻辑短路；
3. 用 `clarify` 作为 Session Init 表单的**载体**（tool_call），并在读回答案时
   解包它回显的 JSON 信封。

第 3 点是本课题真正的技术含量所在：其它客户端（codebuddy / workbuddy / dsh /
opencode）各有自己的表单工具，Hermes 的 `clarify` 与它们**不同构**，
有两处必须实测才能知道的差异（见 §4）。

## 2. 调用模型

```text
用户 ──> hermes CLI / gateway（交互形态，带 clarify）
          │  clarify 工具：本地渲染 提问 → 选择 → 回复
          ▼
       OpenAI Chat Completions（model.provider=custom + model.base_url）
          │  自定义头入口：model.extra_headers / providers.<n>.extra_headers /
          │  custom_providers[].extra_headers（三处等价，合并进 SDK default_headers）
          ▼
       tdai-proxy /hermes/{spaceId}/v1/chat/completions
          │  hermesAdapter.classifyRequest → main
          │  Session Init：clarify tool_call 表单 + 注入 + L0/skill
          ▼
       上游模型
```

无交互 UI 的形态（api-server / acp / `-z` one-shot）请求里**没有** `clarify`，
此时走 headless bypass（与 dsh 的 no-preset 分支对称），见 §4.3。

## 3. 本 PR 的改动清单

| 文件 | 改动 |
|---|---|
| `src/agent-adapters/hermes.ts` | **新增**适配器：`classifyRequest` 恒 `main`；`extractUserText` 字符串直取、数组走 default 兜底 |
| `src/agent-adapters/index.ts` | `resolveAgentAdapter` 增加 `case "hermes"` |
| `src/agent-adapters/types.ts` | `AgentKind` 联合类型加入 `"hermes"` |
| `src/session/hermes/form.ts` | **新增** clarify tool_call 载体（扁平单题 schema、`call_hermes_session_init_` 前缀、4 选项分页） |
| `src/session/hermes/extractor.ts` | **新增** clarify 结果解包（`unwrapClarifyAnswer`） |
| `src/session/index.ts` | 表单重渲染：`agentSource === "hermes"` 时把 CB formData 渲染成 clarify tool_call |
| `src/session/codebuddy/cleaner.ts` | tool_call id 前缀兼容 `call_hermes_session_init_`；读答复时先解包信封 |
| `src/session/codebuddy/init.ts` | `usesSplitAssetStages` 纳入 hermes（clarify 一次只能问一题 → 必须先 agent_select 再 task_select）；分页 `更多 →` 一并拦截 |
| `src/handler.ts` | 抽出 `_hasTool()`；新增 `_hermesHeadless`；`_headerOnlyAgents` 由 `{hermes, openclaw}` 收敛为 `{openclaw}`（hermes 交互形态已有表单入口）；无 clarify 形态 bypass |
| `src/routes/whitelist.ts` | `AGENT_PREFIX_RE` 纳入 `hermes` |
| `src/memory/memory-bridge.ts`、`src/skill/skill-bridge.ts` | 会话键候选前缀加入 `hermes:<sessionId>` |
| `src/__tests__/agent-adapters-hermes.test.ts`、`src/session/hermes/__tests__/*.test.ts` | **新增**契约测试（3 文件 / 21 例） |

## 4. 行为口径与已知边界（与实现一致）

### 4.1 clarify 的参数必须是**扁平单题**，不是 `{questions:[...]}`

本机源码实证：`tools/clarify_tool.py::CLARIFY_SCHEMA` 的 properties 只有
`question`（string）与 `choices`（array，`maxItems: 4`），handler 取
`args.get("question")`。

因此若按 opencode `question` 工具的形态发 `{questions:[{...}]}`，
clarify 会返回 `{"error":"Question text is required."}` —— **用户看不到表单**，
且该 error 会被当成 headless 信号静默 bypass。这是 2026-09-10 联调实测踩到的坑，
也是本课题最值得写进文档的一条。

### 4.2 读答复必须解包信封

clarify 的结果 JSON 会把 `question` 与 `choices_offered` **原样回显**，包含
"跳过"提示语与全部候选标签。若把原始 JSON 直接交给 CB extractor 的子串匹配，
会分别误判成"用户选择跳过"与"用户选择了第一项"。

`unwrapClarifyAnswer()` 只提取 `user_response`，并把三类非答复情形收敛为 bypass：

- `error` 非空（无 UI 形态，如 api-server）；
- `user_response` 含超时文案（`The user did not provide a response within the time limit`）；
- `user_response` 以 `[oneshot mode:` 开头（`-z` 无人应答）。

解包只发生在**读答复**处，不改请求 body，转发给上游的消息保持原样。

### 4.3 headless（无 clarify）与 dsh 对称

`_hermesHeadless = agentSource === "hermes" && !_hasTool("clarify")`。命中时：

- 不弹表单（避免把 fake tool_call 塞给不认识它的 agent-loop）；
- `injectedSkipped = true`，且**本轮没有可用会话时**不注入 / 不写 L0 / 不提取 skill
  （`_hermesHeadlessNoSession = _hermesHeadless && !sessionInfo`）。
  若此前已在交互形态下建过会话，则照常走完整链路。

`mem:session-reset` 在无表单入口的形态下返回"不支持"文案（原 `_headerOnlyAgents`
含 hermes 的那条已按新行为改写）。

### 4.4 其余边界

- **aux 判定保守**：未发现 Hermes compaction / title 请求的独立 header 或 body 指纹，
  `classifyRequest` 恒 `main`，代价是这类低频请求多一次注入（不破坏链路）；
- **clarify 尚未实测的能力**：`choices` 上限 4，UI 会自动追加 "Other (type your answer)"，
  因此用户始终可手输；分页沿用 `computePagination`（非末页 3 项 + "更多" 尾槽）。

## 5. 验证

### 5.1 单测（仓库内可复现）

```bash
cd MemoryProxy
npx vitest run          # 本 PR 分支：3 文件 / 21 例通过
npx tsc --noEmit        # 与 #1326 合并后为 0 错误
```

覆盖：适配器注册与三个适配点、clarify schema 形状（扁平单题）、tool_call id 前缀、
信封解包（正常答复 / error / 超时 / one-shot / 非信封 JSON）、分页与选项渲染。

### 5.2 真机端到端冒烟（**未被 CI 覆盖，需人工执行并留存日志**）

前提：本机已装 `hermes-agent`，MemoryProxy 指向真实上游。

```yaml
model:
  provider: custom
  name: <模型名>
  base_url: http://<proxy>:8096/hermes/<spaceId>/v1
  extra_headers:
    x-team-id: <teamId>
    x-agent-id: <agentId>
    x-task-id: <taskId>
```

```bash
hermes chat
# 会话初始化应弹出 clarify 面板 → 选择 Team / Agent / Task
```

观察点（用于判断接线真的生效）：

- 日志出现 `agentSource=hermes`、`session-init:cb` 状态流转；
- 弹出的 question 是**单题**（先 Team，再 Agent，再 Task），不是把 agent+task 一起问；
- clarify 结果经 `unwrapClarifyAnswer` 解包后，`[session-init:cb]` 能识别出团队/Agent；
- headless 形态（api-server）日志出现 `agent=hermes headless/no-clarify … bypass`。

## 6. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| Hermes 给 aux 请求（compaction/title）加稳定 header | 上游版本升级 | 把该指纹补进 `classifyRequest`（同 dsh 的 `x-deepseek-harness-compact` 模式）；契约测试先红 |
| Hermes 改发 content-block 数组 | OpenAI SDK 形态变化 | `extractUserText` 已走 `defaultAdapter` 拼接兜底 |
| clarify schema 漂移（`question`/`choices` 改名或上限变化） | hermes-agent 升级 | `HERMES_MAX_CHOICES` 与 `TOOL_NAME` 是常量；契约测试锁定当前形状 |
| 把 clarify 的 JSON 信封原样交给 extractor | 新增读答复路径 | 解包收敛在 `cleaner.ts::getLastUserMessageText` 单一入口；`isClarifyAnswerEnvelope()` 可复用 |

## 7. 待补：作者的理解与后续规划（**汇报时补写，当前为空**）

> 本节留给作者本人补写，避免由实现细节反推意图。计划包含：
>
> - 对 Hermes 交互式 tools 调用模型的理解（与 opencode / dsh 的同与不同）；
> - 本次接入解决了什么、没解决什么；
> - 后续规划（例如 native tool_use 化、aux 指纹补充、与 TRACK 02 的适配层收敛）。
