# Opik 可观测接入（TRACK 06 / #1270 → #1310）

> 状态：已实现并验证（OpenAI Chat、Anthropic、OpenAI Responses 三条主链路均已接入）
> 覆盖范围：调用链路 / Token / 记忆注入（配置级 + 本轮逐钩子运行统计）/ 工具交互 / memory-access 审计

## 1. 背景与目标

Proxy 此前只有散落的控制台日志（`config-audit` / `model-map` / `usage-compat` /
`troubleshoot`），排障要对着日志逐行 grep。本 PR 在已有 Chat / Anthropic 的
Opik 上报链路上补齐：

- **上报可靠性**：统一 `sendOpikRequest`（超时 / 熔断 / 限频日志，全程
  fire-and-forget）；
- **trace metadata**：调用链路 / 记忆注入（配置级 + 逐钩子运行统计）/
  工具交互三类结构化字段，字段白名单 + 长度封顶；
- **memory-access 审计线**：谁在什么时候**读了/写了**谁的记忆（JSONL 落盘 + 轮转）；
- **配置兼容与迁移**：`opik.apiPrefix` / `timeoutMs` 可配置，并为旧
  `url=:5173` 配置做向后兼容。

明确不在本 PR 范围（不会假装已实现）：

- Opik 官方完整栈的其它模块（python-backend / guardrails / demo-data / otel
  等）与生产级高可用不在本仓库；仓库只带 trace 上报必需组件的裁剪版 compose
  （见 §5）。

## 2. 架构与数据流

```
WorkBuddy Web (OpenAI Chat) ──┐
                              ├── tdai-proxy ── fire-and-forget ──▶ Opik backend (8080)
Claude Code (Anthropic) ──────┘      │
                                     └── memory-access audit (JSONL)

Codex / WorkBuddy Desktop (Responses) ─┘（本 PR 补齐）
```

打点全部 fire-and-forget：`opik.ts` 内部每个请求单独 `fetch`，失败只打
`opik.*_error / *_failed` 等限频 warn，**绝不阻塞或改变业务响应**。配置默认关闭，
不配 Opik 时零网络开销。

## 3. 改动清单（截至本分支；叠加分支含前序 PR 的累计内容）

| 文件 | 改动 |
|---|---|
| `src/opik.ts` | 统一上报通道：超时 / 熔断（5 次 → 30s）/ 10s 限频；`apiPrefix`、`timeoutMs` 可配置；`opikTurnTag` 同轮提问稳定分组标签；fork `request_log` 脱敏 |
| `src/opik-metadata.ts` | trace metadata 纯函数：字段白名单、长度封顶、工具交互摘要（只留名称与条数）、`buildMemoryInjectionContext`（配置级 + 逐钩子运行统计汇总） |
| `src/injection/pipeline.ts` | `processWithStats`：把管线本就算好的每钩子 `HookResult[]` 透给调用方；`process()` 保持原签名兼容包装 |
| `src/audit.ts` | memory-access 审计：`buildAuditPayload` 纯函数、trace_id 完整保留、JSONL 大小轮转 |
| `src/config.ts` / `config.example.yaml` | `opik.apiPrefix` / `timeoutMs`；旧 `:5173` 配置自动兼容 `/api/v1/private` |
| `src/handler.ts` | OpenAI Chat（WorkBuddy Web）：create trace / LLM span 挂 metadata |
| `src/anthropicHandler.ts` | Anthropic（Claude Code）：同上 |
| `src/codexHandler.ts` / `src/workbuddyHandler.ts` | OpenAI Responses（Codex / WorkBuddy Desktop）：create trace + 流式 completed LLM span + metadata（2026-09-06 补齐） |
| `src/opik-metadata.ts` | 新增 Responses input[] 工具交互摘要 |
| `src/tdai/recorder.ts` + `src/tdai/client.ts` | L0 写入结果可判定：真实成功后记一条审计；HTTP/网络失败抛错可重试；审计事件带 trace_id |
| `src/injection/injectors/tdai-l1-recall-injector.ts` | 读路径审计：L1 自动召回按命名空间记 `action=recall`（含命中 0；自有 + 借入都记） |
| `src/memory/memory-bridge.ts` | 读路径审计：只读子路径按语义记 `action=search / query / read`，借入读的 target 指向被借 agent |
| `deploy/opik-compose.yml` + `deploy/opik-assets/` | 自托管 Opik 栈（裁剪官方 v2.2.49，backend 8080 / frontend 5173，数据落 named volume） |
| `deploy/global-images/start-proxy.sh` + `.env.example` | `PROXY_OPIK_*` 环境变量透传；生成的 config.yaml 自动带 opik 段 |
| 上游类型修复 | 与 #1226 / #1251 一致的 base 类型修复（6 文件逐字节相同） |
| 测试 / 文档 | opik / opik-metadata / audit 用例（vitest **35/35**，含 request_log 开关、失败 trace 收尾、批量队列新增用例）；上游 v2.0.2-beta.1 已删除 base 自带 user-query-extractor 8 个用例；本设计文档 |

> 说明：Responses（Codex / WorkBuddy Desktop）主链路已在 2026-09-06 评审修复轮补齐；
> 自托管 compose 与 `PROXY_OPIK_*` 透传随本 PR 提供（见 §5）；官方完整栈的
> 其它模块（python-backend / guardrails / demo-data / otel 等）不在本仓库。

## 4. trace / span 携带的 metadata

| 字段 | 含义 |
|---|---|
| `agent_source` | workbuddy / claude-code / codex |
| `protocol` | openai / anthropic / responses |
| `session_key` / `conversation_id` | 客户端会话标识 |
| `space_id` / `user_id` / `model` / `stream` / `turn_seq` / `request_path` | 身份、路由与轮次 |
| `memory_injection` | 配置级：`enabled` / `injector_count` / `skipped`；运行级：`hook_count` / `block_count` / `error_count` / `hooks`（逐钩子明细） |
| `tool_interaction` | `toolCalls[]`（工具名）+ `toolResults`（结果条数） |

另外，当 `opik.requestLogEnabled: true` 时，Chat / Anthropic / Responses 的 trace 会
额外 fork 一份到 `request_log` 项目（独立 traceId；`opik.stripRequestLogContent: true`
时只留 usage + 标签），供原始请求留痕，不污染主项目视图。该项**默认关闭**——开启后
Opik 上报量约翻倍，仅在需要排查原始请求时打开。
主项目 trace 还额外带 `turn:<hash>` 标签：同一轮用户提问的工具循环请求共享
同一 (sessionKey, turnSeq)，因此 traceId 与标签都一致，可按 `turn:<hash>`
过滤，也可直接在 Opik 树形视图看到同一条 trace 下的全部 span。

## 5. 配置与启用

本 PR 随仓库提供自托管 compose（`deploy/opik-compose.yml` + `deploy/opik-assets/`，
裁剪自官方 v2.2.49 栈，只保留 trace 上报必需组件）。启动：

```bash
cd deploy
docker compose -f opik-compose.yml --profile opik up -d --pull missing
```

`deploy/global-images` 的容器化部署（start-all / start-proxy）则直接在 `.env`
打开透传变量，脚本会在生成的 config.yaml 里写入 opik 段：

```dotenv
PROXY_OPIK_ENABLED=1                          # 1 = 开启 Opik 上报
PROXY_OPIK_URL=http://host.docker.internal:5173   # opik frontend（nginx 代理 /api/* 到 backend）
PROXY_OPIK_API_KEY=                           # 自托管无鉴权可留空
```

也可以绕过脚本、在 Proxy 的 `config.yaml` 手工配置：

```yaml
opik:
  enabled: true
  url: "http://host.docker.internal:8080"   # 容器内访问宿主机用 host.docker.internal
  apiKey: ""                                 # 自托管无鉴权可留空
  apiPrefix: "/v1/private"                   # backend(8080)；指向前端(5173) 时改 "/api/v1/private"
  timeoutMs: 2000                            # 单次上报超时（100–30000ms）
  stripRequestLogContent: false              # true = request_log fork 不记录消息内容
  requestLogEnabled: false                   # true = 额外 fork 原始请求到 request_log（默认关闭）
  batch:                                     # create trace / span 批量上报队列
    enabled: true                            # false = 退回逐条立即上报
    maxBatchSize: 20                         # 队列满 20 条立即刷出（2–500）
    flushIntervalMs: 1000                    # 队列未满时最长等待（50–60000 ms）
```

> 迁移说明：升级前若配置 `url: http://127.0.0.1:5173` 且未写 `apiPrefix`，
> 本版本会自动沿用旧行为请求 `/api/v1/private/*`；显式 `apiPrefix` 优先。
> 直连 backend(8080) 的配置默认 `/v1/private`。

## 6. 验证方法（命令行）

### 6.1 造请求（当前已埋点客户端）

```bash
cd /c/Users/<用户名>/Documents/ChatGPT/腾讯犀牛鸟
bash check-token-usage.sh workbuddy wb-persist-0001 "你好"
bash check-token-usage.sh claude   c4015466-4cda-4eb1-83e4-14dfea1a6762 "你好"
bash check-token-usage.sh codex    codex-verif "你好"
```

### 6.2 查 trace（REST）

```bash
curl "http://127.0.0.1:8080/v1/private/traces?project_name=usr-xxxxxxxx&page=1&size=10"
curl "http://127.0.0.1:8080/v1/private/spans?trace_id=<traceId>&project_name=usr-xxxxxxxx&page=1&size=5"
curl "http://127.0.0.1:8080/v1/private/traces?project_name=request_log&page=1&size=10"
```

### 6.3 断言要点

1. trace 的 `metadata.protocol` 为 `openai`（WorkBuddy Web）/ `anthropic`
   （Claude Code）/ `responses`（Codex / WorkBuddy Desktop）；
2. `metadata.memory_injection` 存在，且包含配置级（`enabled / injector_count /
   skipped`）与运行级（`hook_count / block_count / error_count / hooks`）字段；
3. trace 带真实 `usage`，`span_count >= 1`；
4. 审计 JSONL 只出现在 **L0 真实写入成功后**，且带完整 `trace_id`；
5. `stream:false` 的非流式 JSON 同样上报：trace + LLM span（forward 的
   非 SSE 分支读取 usage/output 后完成 update + span）；
6. UI：`http://127.0.0.1:5173` → Projects → `usr-xxxxxxxx` 可看到 trace 与
   messages 面板。

### 6.4 实测结果（本地自测示例，数值随请求变化）

| 客户端 | protocol | span | 说明 |
|---|---|---|---|
| WorkBuddy Web | openai | 1 | create trace + LLM span + metadata |
| Claude Code | anthropic | 1 | create trace + LLM span + metadata |
| Codex | responses | 1 | create trace + 流式 completed LLM span + metadata |
| WorkBuddy Desktop | responses | 1 | 同上 |

## 7. 已知边界（与实现一致）

- **Responses 工具调用摘要**：`summarizeResponsesToolInteraction` 覆盖
  input[] 的 `function_call` / `function_call_output`；输出侧 additional 类型
  的工具仍按各协议既有边界处理；
- **Responses 非流式 JSON**：`stream:false` 时上游返回 JSON，codex/workbuddy
  在转发层读取 usage/output 并 update trace + 创建 LLM span（流式与 JSON 两条
  出口均已覆盖）；
- **同一次提问归组**：Opik 沿用 Langfuse 的 turn 语义（同一 `sessionKey +
  turnSeq` 属于同一轮用户提问），四个 handler 用 `opikTurnTraceId` 生成稳定
  UUIDv7 traceId，工具循环请求共享同一条 trace；LLM span 仍按每次调用创建，
  因此 Opik 中呈现“一条 trace + 多个 span”的树。已在本机 Opik 验证：同 ID
  重复 POST 幂等、多 span 同 trace 正常、并发 PATCH 不损坏数据（最后一次写入
  生效）。
- **记忆注入字段语义**：`injector_count` 是配置声明的注入器数量（配置级）；
  `hook_count / block_count / error_count` 是本轮注入管线真实运行结果
  （运行级），`hooks` 给出每个 hook 的 `point / block_count /
  cache_strategy / error` 明细。`skipped=true` 或未启用注入时不执行管线，
  因此只有配置级字段；
- **逐钩子错误只落布尔位**：`error: true` 表示该钩子本轮执行抛错，错误原文
  不写入 Opik metadata（避免内部信息外泄），完整信息在结构化日志
  `injection.hook.error` 中；钩子失败不阻断管线，业务照常转发；
- **hooks 上限 20 条**：常规生产配置每轮 ≤ 8 个钩子；超过 20 时只保留前
  20 条明细，计数不受影响；
- **审计只在真实写入后记录**：`TdaiClient.addConversation` 现在会返回是否写入、
  在失败时抛错（供 `withL0Retry` 重试），`recordTdaiTurn` 仅在成功的那次写入后
  落一条 `l0` 审计并携带请求 `trace_id`；未启用 / `writeL0=false` / 无消息时不落；
- **审计已覆盖读路径**：写路径（L0）+ 读路径（L1 自动召回、memory-bridge 只读子路径）均已接入，口径见 §14；
- **API 前缀兼容**：`apiPrefix` 显式优先；未配置时按 url 自动选择
  （`:5173` → `/api/v1/private`，其余 → `/v1/private`）；
- **多模态 document / audio、Responses 会话状态端点**仍按各协议既有边界处理，
  不在本 PR 扩大范围；
- **Opik 自托管部署**：仓库提供 `deploy/opik-compose.yml`（backend 8080 /
  frontend 5173，数据落 named volume）；首次启动需拉镜像（`pull_policy: missing`，
  本地有镜像时可离线），compose 内为本地开发凭据（opik/opik 等），上线请自行
  更换密钥。

## 8. 可靠性加固与评审修复（2026-09-06）

- **统一上报通道**：create trace / update trace / LLM span（含 fork）收敛到
  `sendOpikRequest`：单次超时（`timeoutMs` 默认 2000ms）、连续失败熔断
  （5 次 → 30s）、同类错误限频（10s 一条 warn）；fire-and-forget；
- **trace metadata 四类定位信息（粗粒度 + 逐钩子运行统计）**：
  `opik-metadata.ts` 纯函数组装，字段白名单 + 长度封顶；四个 handler
  （Chat / Anthropic / Codex / WorkBuddy）统一经 `buildMemoryInjectionContext`
  把注入管线本轮 `HookResult[]` 汇总进 `memory_injection`（injection
  `pipeline.processWithStats` 只透出管线本就计算好的结果，不增加任何网络
  调用与共享状态）；create trace 与非流式 LLM span 挂载，流式 span 复用
  同一 trace；
- **audit 审计线加固**：`buildAuditPayload` 纯函数（长度封顶、默认值归一、
  trace_id 完整保留）；JSONL 大小轮转；失败静默不阻塞业务；
- **评审修复（2026-09-06）**：① 评审质疑的“Responses 主链路无 Opik”以真接入
  收口（codex/workbuddy create trace + 流式/非流式 LLM span）；② “compose 无法
  执行 / start-proxy 不透传”以真交付收口——仓库新增 `deploy/opik-compose.yml`
  与 `deploy/opik-assets/`，`deploy/global-images/start-proxy.sh` 支持
  `PROXY_OPIK_*` 环境变量透传（.env.example 同步）；③ 审计改为“真实写入成功后
  记录一次”，失败抛错让 `withL0Retry` 真正生效且不再重复审计；④ 审计事件携带
  请求 trace_id；⑤ `apiPrefix` 对旧 `:5173` 配置自动兼容；⑥ 评审质疑的
  `hookCount=5 / 逐钩子统计` 从“删声明”升级为“真实现”——注入管线透出本轮
  逐钩子 `HookResult[]`，四个 handler 统一写入 `memory_injection` 运行级字段。

## 9. 2026-09-09 补充

- **L0 非流式写入不再阻塞回复**：Chat / Anthropic 的 `stream:false` 路径原来
  直接 `await recordTdaiTurn`，若内存服务失败可能让已成功的模型回复报 500。
  现改为 `trackWrite(withL0Retry(...).catch(...))`：重试仍发生、失败只记日志，
  与流式路径行为一致，不影响业务响应；审计仍只在真实写入成功那次产生一条。
- **同轮提问打稳定 `turn:` 标签**：四个 handler 的 Opik create trace 与
  LLM span 统一打 `turn:<hash>`（hash = sha256(sessionKey:turnSeq) 前 16 位），
  工具循环产生的多条请求可在 Opik 按同一标签过滤归组；request_log 主语义与
  traceId 组织不变。

## 10. 2026-09-09 补充：traceId 按轮次提问归组

- 在 §9 标签归组之上进一步实现真正的树形归组：`opik.ts` 新增
  `opikTurnTraceId(sessionKey, turnSeq)`，从同一 seed 派生稳定的 UUIDv7。
- 四个 handler 的主 trace 不再用请求级随机 `uuidv7()`，而改用该确定性
  traceId；同一轮提问的工具循环请求自动共享同一条 trace，每次 LLM 调用仍
  作为独立 span 挂在其下。
- 本机 Opik 实测结论：同 ID 重复 POST 幂等（项目内仍是 1 条 trace）；多个
  span 共享同一 trace 正常展示；并发 PATCH 全部成功、数据不损坏（output 为
  最后写入者）。因此该方案可直接使用，无需 409 特殊处理。

## 11. 2026-09-09 补充：问题指纹标签（不参与 traceId）

- 相同内容的提问不会共用 traceId：不同轮次 / 不同会话仍是不同执行 trace。
- 为支持“同一问题被问过几次”的统计，trace 额外带 `question:<hash>` 标签；
  hash 来自归一化后的用户提问文本（NFKC + 空白折叠 + 小写）。
- 该标签只用于过滤 / 统计，绝不参与 traceId 派生，避免不同用户或不同时间
  的相同问题被错误合并。

## 12. 2026-09-09 补充：request_log 可配置 + 失败 trace 收尾

### 12.1 `request_log` 开关（`opik.requestLogEnabled`）

- 新增配置 `opik.requestLogEnabled`（默认 `false`）：为 `true` 时，Chat / Anthropic 的
  trace 会**额外 fork 一份到独立的 `request_log` 项目**，用于留痕排查。
- 默认关闭的原因：开启后 Opik 上报量约翻倍（每条请求多一份 create trace + span），
  只有需要排查原始请求时才打开。
- 与 `opik.stripRequestLogContent` 配合：后者为 `true` 时，fork 出去的 `request_log`
  trace 不记录消息内容（节省存储）。
- fork trace 的收尾改用专用 `opikUpdateTraceFork()`（项目名在函数内部处理），
  不再依赖调用点传入 `projectName`。

```yaml
opik:
  enabled: true
  requestLogEnabled: false        # true = 额外 fork 一份原始请求到 request_log 项目
  stripRequestLogContent: false   # true = fork 出的 request_log trace 不记录消息内容
```

### 12.2 失败请求的 trace 收尾（`opikReportFailure`）

- 新增 `opikReportFailure(...)`：请求在上游失败（4xx/5xx、超时、流式中断）时，
  也把 trace **正常收尾**——写 `end_time` + error metadata，并补一条 error LLM span，
  保证错误请求在 Opik 的消息面板可见、trace 不会永远停留在"进行中"。
- 保护已成功写入的内容：只补 `end_time` / error metadata，**不覆盖**此前成功请求
  写入的 `output`。
- 开启 `requestLogEnabled` 时，fork 出的 trace / span 会一并收尾，不留"影子 trace"。
- 上报侧同时保留超时 / 熔断（连续失败 5 次 → 熔断 30s）与限频，失败只降级为日志，
  **绝不阻塞或改变业务响应**（默认 `opik.timeoutMs: 2000`）。

### 12.3 验证

- `opik.test.ts` 新增用例：`opikReportFailure` 关闭 trace + 补 error LLM span；
  开启 `requestLogEnabled` 时 fork trace / span 一并收尾。
- 上线前自查：失败请求在 `request_log`（如已开启）与主项目里都能看到 `end_time`。

## 13. 2026-09-09 补充：create / span 批量上报队列

- **批量提交**：create trace / create span 先进内存 FIFO 队列，
  - 同类条目累计到 `opik.batch.maxBatchSize`（默认 20，范围 2–500）立即刷出；
  - 未满时最长等待 `opik.batch.flushIntervalMs`（默认 1000 ms，范围 50–60000）刷出；
  - 刷出时走 `POST /v1/private/traces/batch` 或 `POST /v1/private/spans/batch`。
- **顺序保证**：`update trace`（PATCH）没有批量端点，仍逐条发送，但与 create 共用
  同一 FIFO —— 先 create、后 PATCH / 挂 span 的顺序不会被打乱，避免"PATCH 早于
  create 导致 trace 永远打不开"。
- **兼容降级**：老版本 Opik 无 batch 端点（404 / 405）时自动逐条回退，不丢数据；
  `opik.batch.enabled: false` 完全退回"逐条立即上报"的旧行为。
- **退出前 flush**：`index.ts` 的 gracefulShutdown 会先 `flushOpikBatchQueue()`，
  避免容器滚动重启丢尾部队列。

```yaml
opik:
  batch:
    enabled: true
    maxBatchSize: 20        # 队列满 20 条立即刷（2–500）
    flushIntervalMs: 1000   # 队列未满时最长等待（50–60000 ms）
```

**验证**：vitest 35/35 通过、typecheck 通过；新增用例覆盖"连续 create 合并成
`/traces/batch`""队列满立即刷""`batch.enabled=false` 退化逐条""batch 端点 404 时逐条回退
不丢数据"。

## 14. 2026-09-10 补充：memory-access 审计覆盖读路径

### 14.1 背景

#1270 落地审计线时只覆盖写路径（`tdai/recorder.ts` 的 `action=write`，对应 L0 写入），
读路径（recall / search）当时列为后续项。本层把读路径补齐，审计线从"只记写入"
变成"读 + 写都有台账"。

### 14.2 两个读入口 → 四类 action

| 读入口 | 触发点 | action | target 语义 |
|---|---|---|---|
| L1 自动召回 | `tdai-l1-recall-injector`：每轮注入前查 self + 借入 ≤2 个命名空间 | `recall` | 每个被查命名空间各一条 `team:agent[:task]`；借入读指向**被借 agent** |
| memory-bridge | `atomic/search`、`conversation/search` | `search` | 同上（search 类扇出到 self + 借入，一条请求可能落 1~3 条） |
| memory-bridge | `atomic/query`、`conversation/query` | `query` | 同上 |
| memory-bridge | `scenario/ls`、`scenario/read` | `read` | 单目标（可由 `body.agent_id` 指定） |

映射集中在 `memory-bridge.ts::auditActionForSubpath()`（纯函数，单测覆盖）。

### 14.3 字段口径（沿用 #1270 的 payload schema，未新增字段）

| 字段 | 读路径取值 |
|---|---|
| `actor_user` / `actor_agent` | 发起读的一方（会话绑定的 `user_id` / `agent_id`） |
| `target` | 被读命名空间。**借入读时 actor 与 target 前缀不同**，一眼能看出"读了别人的记忆" |
| `result` | 命中条数；无法计数时回落 `http_<status>`（如 `scenario/read` 返回纯文本） |
| `session_key` | 逻辑会话 ID（与写路径一致，取 `session_info.session_id`） |
| `scope` | `normal` / `no-task`，与写路径同口径，不引入新枚举 |
| `trace_id` | 召回路径用当轮 `traceId`；bridge 优先取调用方透传的 `x-tdai-trace-id`（可与当轮 Opik trace 对齐），否则回落 `memory-bridge:<session_id>` |

### 14.4 行为边界（与实现一致）

- **只记成功**：与写路径一致，上游非 2xx 不记（失败由 bridge 的 reject/telemetry 线负责）。
  注意聚合 search 路径上游全失败时仍返回 200 envelope，因此同样不记。
- **命中 0 也记**：'查了但没命中' 与 '压根没查' 是两回事——排查"这轮为什么没召回"需要前者。
- **fire-and-forget**：审计写盘失败只降级日志（`audit.*`），绝不影响读请求本身。
- **不做鉴权判定**：审计是"事后台账"，不参与 allowlist / ACL 决策。

### 14.5 验证

```bash
cd MemoryProxy
npx vitest run src/__tests__/memory-access-audit.test.ts   # 7/7
npx tsc --noEmit                                            # 0 错误
```

真机（需真实内核 + 设 `AUDIT_LOG_FILE`）：一轮对话后 `audit.jsonl` 出现
`{"action":"recall","target":"<team>:<agent>[:<task>]","result":<命中条数>}`；
LLM 通过 Bash curl 调 `/memory-bridge/v3/atomic/search` 后出现 `{"action":"search",...}`；
`scenario/read` 出现 `{"action":"read",...}`。
