# Opik 可观测接入（TRACK 06 / PR #1270）

> 状态：已实现并验证（OpenAI Chat、Anthropic、OpenAI Responses 三条主链路均已接入）
> 覆盖范围：调用链路 / Token / 记忆注入（粗粒度）/ 工具交互 / memory-access 审计

## 1. 背景与目标

Proxy 此前只有散落的控制台日志（`config-audit` / `model-map` / `usage-compat` /
`troubleshoot`），排障要对着日志逐行 grep。本 PR 在已有 Chat / Anthropic 的
Opik 上报链路上补齐：

- **上报可靠性**：统一 `sendOpikRequest`（超时 / 熔断 / 限频日志，全程
  fire-and-forget）；
- **trace metadata**：调用链路 / 记忆注入（粗粒度）/ 工具交互三类结构化字段，
  字段白名单 + 长度封顶；
- **memory-access 审计线**：谁在什么时候写了谁的 L0（JSONL 落盘 + 轮转）；
- **配置兼容与迁移**：`opik.apiPrefix` / `timeoutMs` 可配置，并为旧
  `url=:5173` 配置做向后兼容。

明确不在本 PR 范围（不会假装已实现）：

- 逐注入钩子的 `hookCount / blockCount / errorCount` 统计尚未接入
  （当前只有粗粒度 `memory_injection.enabled / injector_count / skipped`）；
- Opik 自托管栈的 compose / 部署脚本不在本仓库（见 §5 手工部署说明）。

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
| `src/opik.ts` | 统一上报通道：超时 / 熔断（5 次 → 30s）/ 10s 限频；`apiPrefix`、`timeoutMs` 可配置；fork `request_log` 脱敏 |
| `src/opik-metadata.ts` | trace metadata 纯函数：字段白名单、长度封顶、工具交互摘要（只留名称与条数） |
| `src/audit.ts` | memory-access 审计：`buildAuditPayload` 纯函数、trace_id 完整保留、JSONL 大小轮转 |
| `src/config.ts` / `config.example.yaml` | `opik.apiPrefix` / `timeoutMs`；旧 `:5173` 配置自动兼容 `/api/v1/private` |
| `src/handler.ts` | OpenAI Chat（WorkBuddy Web）：create trace / LLM span 挂 metadata |
| `src/anthropicHandler.ts` | Anthropic（Claude Code）：同上 |
| `src/codexHandler.ts` / `src/workbuddyHandler.ts` | OpenAI Responses（Codex / WorkBuddy Desktop）：create trace + 流式 completed LLM span + metadata（2026-09-06 补齐） |
| `src/opik-metadata.ts` | 新增 Responses input[] 工具交互摘要 |
| `src/tdai/recorder.ts` + `src/tdai/client.ts` | L0 写入结果可判定：真实成功后记一条审计；HTTP/网络失败抛错可重试；审计事件带 trace_id |
| 上游类型修复 | 与 #1226 / #1251 一致的 base 类型修复（6 文件逐字节相同） |
| 测试 / 文档 | opik 9 + opik-metadata 6 + audit 3（vitest 26/26）；本设计文档 |

> 说明：Responses（Codex / WorkBuddy Desktop）主链路已在 2026-09-06 评审修复轮补齐；
> 本 PR 仍**不含** `deploy/opik-compose.yml` 或 `start-proxy.sh` 的 `PROXY_OPIK_*` 透传（部署按官方 compose + 手工 YAML）。

## 4. trace / span 携带的 metadata

| 字段 | 含义 |
|---|---|
| `agent_source` | workbuddy / claude-code / codex |
| `protocol` | openai / anthropic / responses |
| `session_key` / `conversation_id` | 客户端会话标识 |
| `space_id` / `user_id` / `model` / `stream` / `turn_seq` / `request_path` | 身份、路由与轮次 |
| `memory_injection` | 粗粒度：`enabled` / `injector_count` / `skipped`（逐钩子统计为后续项） |
| `tool_interaction` | `toolCalls[]`（工具名）+ `toolResults`（结果条数） |

另外每次 Chat / Anthropic trace 会 fork 一份到 `request_log` 项目（独立
traceId，默认脱敏只留 usage + 标签），供原始请求留痕，不污染主项目视图。

## 5. 配置与启用

本 PR 不提供自托管 compose（仓库内无 `deploy/opik-compose.yml`）。请在部署侧
按 Opik 官方文档启动 backend/frontend，然后在 Proxy 的 `config.yaml` 手工配置：

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
2. `metadata.memory_injection` 存在（`enabled / injector_count / skipped`）；
3. trace 带真实 `usage`，`span_count >= 1`；
4. 审计 JSONL 只出现在 **L0 真实写入成功后**，且带完整 `trace_id`；
5. UI：`http://127.0.0.1:5173` → Projects → `usr-xxxxxxxx` 可看到 trace 与
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
- **记忆注入为粗粒度**：只有 `enabled / injector_count / skipped`；
  逐钩子 `hookCount / blockCount / errorCount` 需接入
  `StatsInjectionObserver` 后补充（后续项）；
- **审计只在真实写入后记录**：`TdaiClient.addConversation` 现在会返回是否写入、
  在失败时抛错（供 `withL0Retry` 重试），`recordTdaiTurn` 仅在成功的那次写入后
  落一条 `l0` 审计并携带请求 `trace_id`；未启用 / `writeL0=false` / 无消息时不落；
- **审计读路径未覆盖**：recall / search 读路径接入为后续项；
- **API 前缀兼容**：`apiPrefix` 显式优先；未配置时按 url 自动选择
  （`:5173` → `/api/v1/private`，其余 → `/v1/private`）；
- **多模态 document / audio、Responses 会话状态端点**仍按各协议既有边界处理，
  不在本 PR 扩大范围；
- **Opik 自托管部署**：仓库不包含 compose/启动脚本，按官方文档部署 backend
  （MySQL + ClickHouse + Redis + MinIO + ZooKeeper）与 frontend。

## 8. 可靠性加固与评审修复（2026-09-06）

- **统一上报通道**：create trace / update trace / LLM span（含 fork）收敛到
  `sendOpikRequest`：单次超时（`timeoutMs` 默认 2000ms）、连续失败熔断
  （5 次 → 30s）、同类错误限频（10s 一条 warn）；fire-and-forget；
- **trace metadata 四类定位信息（粗粒度）**：`opik-metadata.ts` 纯函数组装，
  字段白名单 + 长度封顶；`handler.ts` / `anthropicHandler.ts` 在 create trace
  与非流式 LLM span 挂载，流式 span 复用同一 trace；
- **audit 审计线加固**：`buildAuditPayload` 纯函数（长度封顶、默认值归一、
  trace_id 完整保留）；JSONL 大小轮转；失败静默不阻塞业务；
- **评审修复（2026-09-06）**：① 文档收窄为实际埋点范围（移除 Codex/Responses、
  compose、start-proxy、hookCount=5 等不实声明）；② 审计改为“真实写入成功后
  记录一次”，失败抛错让 `withL0Retry` 真正生效且不再重复审计；③ 审计事件携带
  请求 trace_id；④ `apiPrefix` 对旧 `:5173` 配置自动兼容。
