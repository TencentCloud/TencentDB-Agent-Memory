# 06 配置控制面

## Gateway 配置解析

```mermaid
flowchart LR
  EnvPath["TDAI_GATEWAY_CONFIG"] --> Loader["loadGatewayConfig()"]
  CwdFile["./tdai-gateway.yaml/json"] --> Loader
  DataFile["<dataDir>/tdai-gateway.yaml/json"] --> Loader
  EnvVars["TDAI_* env overrides"] --> Loader
  Loader --> GatewayConfig["GatewayConfig\nserver/data/llm/memory"]
  GatewayConfig --> ParseMemory["parseConfig(memory)"]
  ParseMemory --> Core["TdaiCore config"]
```

## 影响行为的配置

| 配置项 | 默认值 | 控制内容 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | Gateway 监听地址。 |
| `server.port` | `8420` | Gateway HTTP 端口；Claude install 默认 8421。 |
| `server.apiKey` / `TDAI_GATEWAY_API_KEY` | unset | 非 `/health` 路由 Bearer auth。 |
| `data.baseDir` / `TDAI_DATA_DIR` | `~/.memory-tencentdb/memory-tdai` 独立运行默认值 | L0/L1/L2/L3 落盘目录。 |
| `llm.baseUrl/model/apiKey` | OpenAI 默认配置 | Gateway 独立运行时的 LLM runner。 |
| `memory.capture.enabled` | `true` | 是否执行 L0 capture。 |
| `memory.extraction.enabled` | `true` | 是否创建 scheduler 和 L1/L2/L3。 |
| `memory.extraction.enableDedup` | `true` | L1 去重。 |
| `memory.pipeline.everyNConversations` | `5` | L1 threshold。 |
| `memory.pipeline.enableWarmup` | `true` | 新 session 阈值 1->2->4 递增。 |
| `memory.pipeline.l1IdleTimeoutSeconds` | `600` | L1 idle 触发。 |
| `memory.pipeline.l2DelayAfterL1Seconds` | `10` | L1 后 L2 delay。 |
| `memory.pipeline.l2MinIntervalSeconds` | `900` | L2 最小间隔。 |
| `memory.pipeline.l2MaxIntervalSeconds` | `3600` | L2 最大轮询间隔。 |
| `memory.recall.enabled` | `true` | 是否 recall 注入。 |
| `memory.recall.strategy` | `hybrid` | keyword / embedding / hybrid。 |
| `memory.recall.maxResults` | `5` | recall topK。 |
| `memory.recall.timeoutMs` | `5000` | recall 超时后跳过注入。 |
| `memory.embedding.provider` | `none` | 默认禁用向量；配置 openai 等启用。 |
| `memory.embedding.dimensions` | 禁用时为 `0` | VectorStore 维度。 |
| `memory.storeBackend` | `sqlite` | SQLite 或 TCVDB。 |
| `TDAI_GATEWAY_AUTO_START` | CLI/MCP 默认为 false，安装脚本通常写 1 | Gateway 不健康时是否自动启动。 |
| `TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS` | `600` | CLI watchdog 空闲关闭阈值。 |

## 链路未执行的配置原因

| 现象 | 配置原因 |
| --- | --- |
| L0 没写 | `memory.capture.enabled=false` 或 hook 没触发/内容被过滤。 |
| L1 没抽取 | `memory.extraction.enabled=false`、无 LLM runner、threshold/idle 未到。 |
| L2/L3 没出来 | L1 无新 records、L2 delay/min interval 未到、PersonaTrigger 不满足。 |
| MCP search 无结果 | L1 尚未产生、embedding/FTS 不可用、query/filters 不匹配。 |
| Gateway 不自动拉起 | `TDAI_GATEWAY_AUTO_START=0` 且无外部 Gateway。 |
| HTTP 401 | Gateway 设置 apiKey，但 client env 未配置同一 token。 |

## 平台默认值

| 平台 | 数据目录 | 端口 | 配置写入方 |
| --- | --- | --- | --- |
| Codex | `~/.codex/tdai-memory/data` | `8420` | `scripts/install-codex.sh` |
| Claude Code | `~/.claude/tdai-memory/data` | `8421` | `scripts/install-claude-code.sh` |
| Hermes | Gateway `TDAI_DATA_DIR` 或默认值 | 默认 `8420` | Hermes env / Gateway config |
| OpenClaw | OpenClaw state dir + `memory-tdai` | none | OpenClaw plugin config |
