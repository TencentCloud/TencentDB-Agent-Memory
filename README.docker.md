# TencentDB-Agent-Memory

AI Agent 长期记忆服务，为任意 Agent 框架提供四层渐进式记忆能力（L0 对话 → L1 原子记忆 → L2 场景归纳 → L3 用户画像）。

## 镜像信息

| 项目 | 值 |
|------|---|
| 镜像名 | `tencentdb-agent-memory` |
| 基础镜像 | `node:22-slim` |
| 大小 | ~920MB |
| 端口 | 8420 |
| 运行用户 | tdai (uid 10001) |
| PID 1 | tini |

## 快速开始

仓库当前通过 `deploy/global-images/` 提供预构建镜像启动脚本，不包含
`MemoryCore/Dockerfile` 或本地 Compose 构建清单。以下命令从仓库根目录执行。

### 1. 准备配置

```bash
cd deploy/global-images
cp .env.example .env
$EDITOR .env
```

`.env` 至少需要填写 `MEMORY_LLM_*` 和 `PROXY_UPSTREAM_*` 两组 LLM 参数。
镜像、端口、数据卷和内部凭据也可以在同一文件中覆盖。

### 2. 启动前校验

```bash
./verify.sh
# 离线环境可跳过外部 LLM 通路检查：
# ./verify.sh --skip-llm
```

### 3. 启动并验证

```bash
./start-all.sh
curl http://localhost:8420/health
```

也可以只启动 memory-core：

```bash
./start-memory-core.sh
```

完整镜像、端口、凭据和清理说明见
[`deploy/global-images/README.md`](deploy/global-images/README.md)。

## 配置方式

### 配置文件 + 环境变量（推荐）

所有配置项同时支持 **YAML 配置文件** 和 **环境变量**，环境变量优先级更高。

容器内配置文件路径由 `TDAI_GATEWAY_CONFIG` 环境变量指定，默认 `/data/config/tdai-gateway.yaml`。

```
┌─────────────────────────────┐
│  环境变量 (最高优先级)        │  ← Secret 敏感凭证
├─────────────────────────────┤
│  tdai-gateway.yaml 配置文件  │  ← ConfigMap 挂载
├─────────────────────────────┤
│  代码默认值                  │  ← 兜底
└─────────────────────────────┘
```

### 配置文件结构

```yaml
deployMode: service          # standalone | service

server:
  port: 8420
  host: "0.0.0.0"

llm:                         # LLM API (OpenAI 兼容)
  baseUrl: "https://api.lkeap.cloud.tencent.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-v3.2"

redis:                       # Redis (service 模式必需)
  host: "redis:6379"
  keyPrefix: "tdai_memory"

shark:                       # Shark 配置中心 (下发 VDB/COS 凭证)
  baseUrl: "http://shark:8000"

scanner:                     # Timer Scanner
  intervalMs: 500

worker:                      # Pipeline Worker
  pollMs: 200

memory:                      # 记忆引擎调参
  pipeline:
    everyNConversations: 5
    enableWarmup: true
  recall:
    maxResults: 5
    strategy: "hybrid"
```

Standalone 配置参考 `MemoryCore/tdai-gateway.standalone.yaml`。Service 模式的
环境变量和 YAML 示例见 [部署与集成指南](README.deployment.md#service-模式服务化)。

### 环境变量与配置文件对照表

| 环境变量 | YAML 路径 | 默认值 | 说明 |
|---------|----------|--------|------|
| `TDAI_DEPLOY_MODE` | `deployMode` | `standalone` | 部署模式 |
| `TDAI_GATEWAY_CONFIG` | — | `/data/config/tdai-gateway.yaml` | 配置文件路径 |
| `TDAI_LLM_API_KEY` | `llm.apiKey` | — | LLM API Key |
| `TDAI_LLM_BASE_URL` | `llm.baseUrl` | `https://api.openai.com/v1` | LLM 地址 |
| `TDAI_LLM_MODEL` | `llm.model` | `gpt-4o` | 模型名 |
| `REDIS_HOST` | `redis.host` | `127.0.0.1` | Redis 地址 |
| `REDIS_PORT` | `redis.port` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | `redis.password` | — | Redis 密码 |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` | `tdai_memory` | Key 前缀 |
| `SHARK_BASE_URL` | `shark.baseUrl` | — | Shark 地址 |
| `STATE_BACKEND` | `stateBackend` | 自动 | `redis` / `local` |
| `SCANNER_INTERVAL_MS` | `scanner.intervalMs` | `500` | 扫描间隔 |
| `WORKER_POLL_MS` | `worker.pollMs` | `200` | Worker 轮询 |
| `COS_DOMAIN` | `cos.domain` | — | COS 内网域名 |

## K8s / TKE 部署

仓库当前未提供可直接应用的通用 K8s 清单。可以基于下方片段和
[部署与集成指南中的 Service 模式示例](README.deployment.md#k8s-部署)生成环境专用清单，核心做法：

1. **ConfigMap** 挂载 `tdai-gateway.yaml` 到 `/app/config/`
2. **Secret** 通过环境变量注入 `TDAI_LLM_API_KEY` + `REDIS_PASSWORD`
3. **Deployment** 设置 `TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml`

```yaml
# Deployment 中的关键配置
env:
  - name: TDAI_GATEWAY_CONFIG
    value: /data/config/tdai-gateway.yaml
  - name: TDAI_LLM_API_KEY
    valueFrom:
      secretKeyRef:
        name: tdai-memory-secrets
        key: TDAI_LLM_API_KEY
volumeMounts:
  - name: config-volume
    mountPath: /app/config
    readOnly: true
volumes:
  - name: config-volume
    configMap:
      name: tdai-memory-config
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/recall` | 记忆召回 |
| POST | `/capture` | 写入对话 |
| POST | `/search/memories` | L1 记忆搜索 |
| POST | `/search/conversations` | L0 对话搜索 |
| POST | `/session/end` | 结束会话 |
| POST | `/v2/*` | v2 多租户 API（需 Bearer Token） |

## 架构

```
┌─────────────────────────────────────────────────────┐
│                 TencentDB Agent Memory               │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Gateway  │  │ TimerScanner │  │ PipelineWorker│  │
│  │ HTTP API │  │ 500ms 扫描   │  │ 竞争消费      │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│       │               │                 │            │
│  ┌────▼─────────────────────────────────▼────────┐  │
│  │          IStateBackend (Redis / Local)         │  │
│  └───────────────────────────────────────────────┘  │
│       │                                              │
│  ┌────▼───────────┐  ┌────────────┐  ┌───────────┐  │
│  │  TdaiCore      │  │ StorePool  │  │ COS       │  │
│  │  L0→L1→L2→L3   │  │ VDB 连接池 │  │ 对象存储  │  │
│  └────────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │               │
    ┌────▼────┐         ┌────▼────┐     ┌────▼────┐
    │  LLM    │         │  TCVDB  │     │  COS    │
    │ API     │         │ 向量库   │     │ 对象存储│
    └─────────┘         └─────────┘     └─────────┘
```

## 文件结构

```
.
├── MemoryCore/
│   ├── tdai-gateway.standalone.yaml     # Standalone 配置模板
│   ├── tdai-gateway.yaml                # Standalone + Skill 默认配置
│   └── src/gateway/server.ts            # 服务入口
└── deploy/
    ├── global-images/                    # 预构建镜像启动脚本
    └── panel-knowledge-combined/         # Panel + Knowledge 组合镜像
```

## License

Proprietary — Tencent Cloud
