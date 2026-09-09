# Opik 可观测接入（TRACK 06 / PR #1270）

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
- **memory-access 审计线**：谁在什么时候写了谁的 L0（JSONL 落盘 + 轮转）；
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

## 3. 改动清单（本 PR 实际文件）

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
| `deploy/opik-compose.yml` + `deploy/opik-assets/` | 自托管 Opik 栈（裁剪官方 v2.2.49，backend 8080 / frontend 5173，数据落 named volume） |
| `deploy/global-images/start-proxy.sh` + `.env.example` | `PROXY_OPIK_*` 环境变量透传；生成的 config.yaml 自动带 opik 段 |
| 上游类型修复 | 与 #1226 / #1251 一致的 base 类型修复（6 文件逐字节相同） |
| 测试 / 文档 | opik 10 + opik-metadata 11 + audit 3（vitest 24/24；上游 v2.0.2-beta.1 已删除 base 自带 user-query-extractor 8 个用例，对应旧文档 31/31）；本设计文档 |

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

另外每次 Chat / Anthropic trace 会 fork 一份到 `request_log` 项目（独立
traceId，默认脱敏只留 usage + 标签），供原始请求留痕，不污染主项目视图。
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
```

> 迁移说明：升级前若配置 `url: http://127.0.0.1:5173` 且未写 `apiPrefix`，
> 本版本会自动沿用旧行为请求 `/api/v1/private/*`；显式 `apiPrefix` 优先。
> 直连 backend(8080) 的配置默认 `/v1/private`。

## 6. 验证方法（命令行）

### 6.1 造请求（三条主链路，均可直接复现）

```bash
# 1) OpenAI Chat（WorkBuddy Web 形态）
curl -sS -X POST "http://127.0.0.1:8096/workbuddy/default/v1/chat/completions" \
  -H "authorization: Bearer <user_key>" -H "content-type: application/json" \
  -d '{"model":"<model>","stream":false,"messages":[{"role":"user","content":"你好"}]}'

# 2) Anthropic（Claude Code 形态）
curl -sS -X POST "http://127.0.0.1:8096/claude-code/default/v1/messages" \
  -H "x-api-key: <user_key>" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"<model>","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'

# 3) Responses（Codex 形态）
curl -sS -X POST "http://127.0.0.1:8096/codex/default/responses" \
  -H "authorization: Bearer <user_key>" -H "content-type: application/json" \
  -d '{"model":"<model>","stream":false,"input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]}]}'
```

> 三条路径与 `INSTALL.md` 的客户端接入方式一致（`/{agent}/{spaceId}/...`）。把 `<user_key>` 换成面板里的
> `sk-mem-*`，`<model>` 换成上游支持的模型名；`stream:false` 便于一次性看到 JSON 响应。

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
- **审计读路径未覆盖**：recall / search 读路径接入为后续项；
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
