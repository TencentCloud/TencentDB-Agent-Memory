# Opik 可观测接入（TRACK 06）

> 日期：2026-08-27 · 状态：已实现并验证（三协议实测通过）
> 覆盖范围：调用链路 / Token / 记忆注入 / 工具交互

## 1. 背景与目标

Proxy 此前只有散落的控制台日志（`config-audit` / `model-map` / `usage-compat` /
`troubleshoot`），排障要对着日志逐行 grep。本次接入 Opik 自托管版，给每次 LLM
请求生成一条结构化 trace：

- **调用链路**：客户端来源（workbuddy / claude-code / codex）、协议、请求路径、模型、耗时；
- **Token**：每次请求的真实 usage（input / output / total / cache），与代理日志口径对齐；
- **记忆注入**：每个注入钩子的执行统计（hookCount / 每钩子 blockCount、耗时、缓存策略、errorCount）；
- **工具交互**：请求里携带的 function_call 与 function_call_output 汇总。

## 2. 架构与数据流

```
WorkBuddy / Claude Code / Codex
        │  (各协议)
        ▼
tdai-proxy (handler.ts / anthropicHandler.ts / codexHandler.ts)
        │  fire-and-forget：opik.ts 直连 backend REST（/v1/private/*）
        ▼
Opik backend (8080) ── MySQL(元数据) / ClickHouse(trace) / Redis / MinIO
        │
        ▼
Opik frontend (5173，UI)
```

打点全部 fire-and-forget：`opik.ts` 内部每个请求单独 `fetch`，失败只打
`opik.create_trace_error` 等 warn 日志，**绝不阻塞或改变业务响应**。配置默认关闭
（`PROXY_OPIK_ENABLED=0`），不配 Opik 时零网络开销。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `src/opik.ts` | Opik 客户端（create trace / LLM span / update），支持 metadata、fork 到 `request_log` 项目 |
| `src/injection/observer.ts` | 新增 `StatsInjectionObserver` / `CompositeInjectionObserver` / `consumeInjectionStats(traceId)`，按 traceId 暂存注入统计 |
| `src/injection/index.ts` | 注入管线用 Composite observer 包裹，暴露统计消费入口 |
| `src/handler.ts` | OpenAI Chat 路径（WorkBuddy）打点：trace + LLM span + metadata（含注入统计 / 工具交互） |
| `src/anthropicHandler.ts` | Anthropic 路径（Claude Code）打点：同上 |
| `src/codexHandler.ts` | Responses 路径（Codex）打点：同上（本轮补齐） |
| `src/common/responses-chat-compat.ts` | 修复 DashScope `response.incomplete` 事件丢失 usage（本轮补齐） |
| `deploy/opik-compose.yml` | 自托管最小栈：MySQL / ClickHouse / Redis / ZooKeeper / MinIO / backend / frontend |
| `deploy/global-images/start-proxy.sh` | 生成 `opik` 配置段；透传 `PROXY_OPIK_*`；挂载 `opik.ts` / `observer.ts` |

## 4. trace / span 携带的 metadata

| 字段 | 含义 |
|---|---|
| `agent_source` | workbuddy / claude-code / codex |
| `protocol` | openai / anthropic / responses |
| `session_key` / `conversation_id` | 客户端会话标识 |
| `space_id` / `user_id` / `model` / `stream` / `turn_seq` / `request_path` | 身份、路由与轮次 |
| `injection` | `hookCount` / `totalBlockCount` / `errorCount` / 每钩子 `blockCount`、`durationMs`、`cacheStrategy` |
| `tool_interaction` | `toolCalls[]`（工具名）+ `toolResults`（结果条数） |

另外每条 trace 会 fork 一份到 `request_log` 项目（独立 traceId，默认脱敏只留
usage + 标签），供原始请求留痕，不污染主项目视图。

## 5. 启动与启用

```bash
# 1) 启动 Opik 栈（backend 8080 / frontend 5173）
cd deploy
docker compose -f opik-compose.yml up -d

# 2) 确认 backend 就绪
curl http://127.0.0.1:8080/health-check          # → []
curl http://127.0.0.1:5173/health                # → healthy

# 3) 在 deploy/global-images/.env 打开开关并重启 proxy
#    PROXY_OPIK_ENABLED=1
#    PROXY_OPIK_URL=http://host.docker.internal:8080
#    （可选）PROXY_OPIK_API_PREFIX=/v1/private   # 指向前端 5173 时改 /api/v1/private
#    （可选）PROXY_OPIK_TIMEOUT_MS=2000          # 单次上报超时（100–30000ms）
cd deploy/global-images && ./start-proxy.sh
```

> 注意：Proxy 容器内访问宿主机要用 `host.docker.internal:8080`（容器内
> `127.0.0.1` 不是宿主机）；宿主机本地验证才用 `127.0.0.1:8080`。

## 6. 验证方法（命令行）

### 6.1 造一次真实请求（三客户端各一次）

```bash
cd /c/Users/<用户名>/Documents/ChatGPT/腾讯犀牛鸟
bash check-token-usage.sh workbuddy wb-persist-0001 "你好"
bash check-token-usage.sh claude   c4015466-4cda-4eb1-83e4-14dfea1a6762 "你好"
bash check-token-usage.sh codex    codex-verif "你好"
```

### 6.2 查 trace（REST）

```bash
# 项目名 = 用户 id（auth/verify 后的 userId）
curl "http://127.0.0.1:8080/v1/private/traces?project_name=usr-xxxxxxxx&page=1&size=10"

# 看某条 trace 的 LLM span（替换 traceId）
curl "http://127.0.0.1:8080/v1/private/spans?trace_id=<traceId>&project_name=usr-xxxxxxxx&page=1&size=5"

# 看脱敏 fork 项目
curl "http://127.0.0.1:8080/v1/private/traces?project_name=request_log&page=1&size=10"
```

### 6.3 断言要点

1. 三条 trace 的 `metadata.protocol` 分别为 `openai` / `anthropic` / `responses`；
2. `metadata.injection.hookCount == 5`（skill-tools / skill / tdai-profile-memory /
   tdai-l1-recall / tdai-intent-tools），`errorCount == 0`；
3. trace 带 `usage`（workbuddy 看 `prompt_tokens`，claude/codex 看 `input_tokens`），
   `span_count >= 1`；
4. UI 验证：浏览器打开 `http://127.0.0.1:5173` → Projects → `usr-xxxxxxxx`，
   能看到 trace 详情与 messages 面板。

### 6.4 实测结果（2026-08-27）

| 客户端 | protocol | usage | span | injection |
|---|---|---|---|---|
| WorkBuddy | openai | prompt=3409 / total=3443 | 1 | hookCount=5, errorCount=0 |
| Claude Code | anthropic | input=3598 / output=64 / cache_read=3072 | 1 | hookCount=5, errorCount=0 |
| Codex | responses | input=5516 / output=51 / total=5567 | 1 | hookCount=5, errorCount=0 |

## 7. 已知边界

- **API 路径前缀**：Proxy 直连 backend 用 `/v1/private/*`（本版本后端无 `/api`
  前缀；`/api` 前缀是前端 nginx 的转发路径）。前缀已做成配置项
  `opik.apiPrefix`：backend 默认 `/v1/private`；指向前端 5173 时改为
  `/api/v1/private`，无需改代码。
- **Claude Code 非流式测试脚本**：`check-token-usage.sh claude` 不带 `stream` 时，
  上游 DashScope 仍按 SSE 返回且可能 `response.incomplete`（max_tokens 触顶）；
  已修复 `response.incomplete` 的 usage 透传。真实 Claude Code 客户端始终走流式，
  不受影响。
- **Opik 依赖**：backend 需要 MySQL + ClickHouse + Redis + MinIO（+ ZooKeeper）。
  本机镜像若拉不到 Docker Hub，用 DaoCloud 镜像源 `docker pull` 后 `docker tag`
  成官方名即可（compose 内 `pull_policy: never`）。

## 8. 可靠性加固与验证（2026-09-06）

- **opik 客户端统一上报通道**：create trace / update trace / LLM span（含 fork）
  收敛到单一 `sendOpikRequest`：单次超时（`opik.timeoutMs`，默认 2000ms）、连续
  失败熔断（5 次 → 停 30s 再试）、同类错误日志限频（10s 至多一条），全程
  fire-and-forget，绝不阻塞业务；
- **端点可配置**：`opik.apiPrefix`（默认 `/v1/private`）归一化后拼 URL，
  不再硬编码；`opikEndpoint` / `opikApiPrefix` 纯函数导出供单测；
- **trace metadata 携带四类定位信息**：`opik-metadata.ts` 纯函数组装
  调用链路（agent_source / protocol / session_key / conversation_id /
  space_id / user_id / model / stream / turn_seq / request_path）、
  记忆注入（memory_injection.enabled / injector_count / skipped）与
  工具交互（tool_interaction.toolCalls / toolResults，只留工具名与条数，
  不复制消息正文）；handler.ts / anthropicHandler.ts 在 create trace 与
  非流式 LLM span 上挂 metadata，流式 span 复用同一 trace（metadata 在
  trace 层继承，不做重复写入）；
- **audit 审计线加固**：`buildAuditPayload` 纯函数化（字段长度封顶、默认值归一、
  trace_id 保留完整值）；JSONL 落盘支持大小轮转（`AUDIT_LOG_FILE` /
  `AUDIT_LOG_MAX_BYTES`，默认 100MB，超出轮转 `<file>.1`）；任何失败静默降级；
- **单测**：`src/__tests__/opik.test.ts` 9 例（端点归一/上报体/metadata/fork
  脱敏/usage 扁平化/熔断恢复）、`src/__tests__/opik-metadata.test.ts` 6 例
  （metadata 白名单/封顶、OpenAI/Anthropic/legacy 工具摘要）、
  `src/__tests__/audit.test.ts` 3 例（payload 归一/长度封顶/JSONL 轮转）；
- **审计覆盖范围**：当前落在 L0 写路径（tdai recorder write），recall/search
  等读路径接点属后续项，事件结构已预留 action 枚举。

