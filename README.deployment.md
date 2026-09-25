# 部署与集成指南（开源单机 / 云服务化）

> 📖 **本文档专门讲解部署形态、Hermes 集成与端到端验证。**
> 想了解插件的核心能力、配置参数、CLI 工具，请回到 **[主 README](README.md)**。

`memory-tencentdb` 提供 **两种独立部署形态**，两种形态都能被外部 Agent（典型为 Hermes）通过 HTTP API 调用，并各自适配不同的部署规模与运维要求：

| 形态 | 后端存储 | 状态后端 | 多租户 | 适用场景 |
|------|----------|----------|--------|----------|
| **Standalone（开源单机版）** | SQLite + 本地文件 | 进程内 Map / Timer | 单空间 | 本地开发、单 Agent sidecar、Docker 一体化、离线部署 |
| **Service（云服务化版）** | TCVDB + COS | Redis（分布式锁 + 任务队列） | 多空间 per-`service_id` | K8s 多副本、多租户 SaaS、多 Agent 共享记忆 |

```
L0  对话原始记录 (Conversation)    ← 自动写入
L1  原子化结构记忆 (Atomic Memory)  ← LLM 提取 + 去重
L2  场景块 (Scene Blocks)           ← LLM 场景抽取
L3  用户画像 (Persona)              ← LLM 人格合成
```

两种形态共享同一份 Gateway 二进制和同一套 v1/v2 HTTP API，只是配置和后端不同。切换形态只需调整 `TDAI_DEPLOY_MODE` 环境变量。

---

## 快速开始（3 步）

```bash
# 1. 进入 MemoryCore 并安装依赖
cd MemoryCore
npm install

# 2. 配置 LLM
export TDAI_LLM_API_KEY="your-api-key"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# 3. 启动 Gateway
npx tsx src/gateway/server.ts
```

Gateway 默认监听 `http://127.0.0.1:8420`，数据存储在 `~/.memory-tencentdb/memory-tdai/`。

---

## 部署模式

### Standalone 模式（单机）

零外部依赖，所有数据本地存储。适用于：本地开发、单 Agent sidecar、Docker 一体化部署。

**存储**：SQLite（向量 + 记录） + 本地文件系统（L2/L3 文档）
**状态管理**：进程内 Map/Timer

#### 环境变量配置

```bash
# 必须 — LLM 配置
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"   # 默认 https://api.openai.com/v1
export TDAI_LLM_MODEL="deepseek-chat"                     # 默认 gpt-4o
export TDAI_LLM_MAX_TOKENS=4096
export TDAI_LLM_TIMEOUT_MS=120000

# 可选 — 服务配置
export TDAI_GATEWAY_PORT=8420            # 监听端口，默认 8420
export TDAI_GATEWAY_HOST="127.0.0.1"    # 监听地址，默认 127.0.0.1
export TDAI_DATA_DIR="~/.memory-tencentdb/memory-tdai"  # 数据目录
```

#### YAML 配置文件（可选）

配置文件搜索顺序：`$TDAI_GATEWAY_CONFIG` → `./tdai-gateway.yaml` → `<dataDir>/tdai-gateway.yaml`

```yaml
# tdai-gateway.yaml — Standalone 模式
server:
  port: 8420
  host: "127.0.0.1"

data:
  baseDir: "~/.memory-tencentdb/memory-tdai"

llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"
  maxTokens: 4096
  timeoutMs: 120000

# memory 配置（可选，都有合理默认值）
memory:
  capture:
    enabled: true
    excludeAgents: []
  recall:
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"            # hybrid / embedding / keyword
  embedding:
    enabled: true
    provider: "openai"            # none / openai / deepseek / qclaw
    baseUrl: "${TDAI_LLM_BASE_URL}"
    apiKey: "${TDAI_LLM_API_KEY}"
    model: "text-embedding-3-small"
    dimensions: 1536
  bm25:
    enabled: true
    language: "zh"
  storeBackend: "sqlite"          # sqlite（standalone） 或 tcvdb（service）
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutMs: 30000
    l2IntervalMs: 300000
    l3IntervalMs: 600000
```

#### Docker 部署

```bash
# 纯 Gateway
docker run -d \
  -e TDAI_LLM_API_KEY="sk-xxx" \
  -e TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
  -e TDAI_LLM_MODEL="deepseek-chat" \
  -e TDAI_GATEWAY_HOST="0.0.0.0" \
  -p 8420:8420 \
  -v tdai-data:/root/.memory-tencentdb/memory-tdai \
  agentmemory/hermes-memory:latest
```

#### 数据目录结构

```
~/.memory-tencentdb/memory-tdai/
  ├── vectors.db              # SQLite 向量数据库 (L0 + L1)
  ├── conversations/          # L0 对话原始 JSONL
  ├── records/                # L1 结构化记忆
  ├── scene_blocks/           # L2 场景 Markdown 文件
  ├── persona.md              # L3 用户画像
  └── checkpoint.json         # Pipeline 进度
```

---

### Service 模式（服务化）

使用外部存储（TCVDB 向量数据库 + COS 对象存储），支持多副本水平扩展。适用于：K8s 集群、多租户 SaaS、多 Agent 共享记忆。

**存储**：TCVDB（向量搜索） + COS（L2/L3 文档，per-serviceId 路径隔离）
**状态管理**：Redis（分布式锁 + 任务队列）
**配置源**：Shark 服务（动态 VDB/COS 凭证）或环境变量（静态凭证）

#### 环境变量配置

```bash
# ── 部署模式 ──
export TDAI_DEPLOY_MODE="service"           # 关键：启用 service 模式

# ── LLM（同 standalone） ──
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# ── 服务端口 ──
export TDAI_GATEWAY_PORT=3100
export TDAI_GATEWAY_HOST="0.0.0.0"

# ── Redis（分布式状态后端） ──
export STATE_BACKEND="redis"                # redis 或 local（单机测试）
export REDIS_HOST="redis.example.com"
export REDIS_PORT=6379
export REDIS_PASSWORD="your-password"
export REDIS_KEY_PREFIX="tdai_memory"

# ── VDB 向量数据库（直连模式） ──
export VDB_ENDPOINT="http://vdb.example.com:8100"
export VDB_USER="root"
export VDB_API_KEY="your-vdb-api-key"
export VDB_DATABASE="memory-production"

# ── COS 对象存储（直连模式） ──
export COS_SECRET_ID="AKIDxxxx"
export COS_SECRET_KEY="xxxxx"
export COS_TOKEN=""                         # STS 临时凭证时填写
export COS_URL="https://your-bucket.cos.ap-guangzhou.myqcloud.com"
export COS_PATH_PREFIX="tenants/prod/"

# ── 或使用 Shark 配置服务（生产推荐） ──
export SHARK_BASE_URL="http://shark.example.com:8080"
# Shark 会自动提供 per-instance 的 VDB 和 COS 配置

# ── 可选调优 ──
export CONFIG_VDB_TTL_MS=300000             # VDB 配置缓存 TTL，默认 5 分钟
export CONFIG_COS_BUFFER_MS=120000          # COS 凭证提前刷新时间
export CONFIG_MAX_INSTANCES=1000            # 最大缓存实例数
export SCANNER_SPACES="space1,space2"       # Timer Scanner 扫描的空间列表
export TDAI_SPACE_ID="default"              # 当前实例空间 ID
```

#### YAML 配置文件

```yaml
# tdai-gateway.yaml — Service 模式
deployMode: service

server:
  port: 3100
  host: "0.0.0.0"

data:
  baseDir: "/data/tdai-memory"

llm:
  baseUrl: "${TDAI_LLM_BASE_URL}"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"

memory:
  storeBackend: "tcvdb"
  tcvdb:
    embeddingModel: "bge-large-zh"    # VDB 服务端 embedding 模型
    timeout: 10000
  embedding:
    enabled: false                     # TCVDB 服务端自带 embedding，客户端无需
    provider: "none"
  bm25:
    enabled: true
    language: "zh"
  recall:
    strategy: "hybrid"
    maxResults: 10
```

#### K8s 部署

```yaml
# 核心环境变量（通过 ConfigMap/Secret 注入）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tdai-memory-gateway
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: gateway
          image: agentmemory/hermes-memory:latest
          env:
            - name: TDAI_DEPLOY_MODE
              value: "service"
            - name: TDAI_GATEWAY_PORT
              value: "3100"
            - name: TDAI_GATEWAY_HOST
              value: "0.0.0.0"
            - name: STATE_BACKEND
              value: "redis"
            - name: REDIS_HOST
              valueFrom:
                configMapKeyRef:
                  name: tdai-config
                  key: redis-host
            - name: SHARK_BASE_URL
              value: "http://shark-svc:8080"
          ports:
            - containerPort: 3100
---
apiVersion: v1
kind: Service
metadata:
  name: tdai-memory-gateway
spec:
  selector:
    app: tdai-memory-gateway
  ports:
    - port: 3100
      targetPort: 3100
```

#### 多副本架构

```
                    ┌─────────────┐
                    │  Hermes #1  │─┐
                    └─────────────┘ │
                    ┌─────────────┐ │    ┌──────────────────┐    ┌──────────┐
                    │  Hermes #2  │─┼───→│  TDAI Gateway    │───→│  TCVDB   │
                    └─────────────┘ │    │  (N replicas)    │    │  向量库   │
                    ┌─────────────┐ │    │                  │───→│          │
                    │  Hermes #3  │─┘    │  ┌─ Scanner ─┐   │    └──────────┘
                    └─────────────┘      │  │  Worker   │   │    ┌──────────┐
                                         │  └───────────┘   │───→│   COS    │
  每个 Hermes 使用唯一                    └──────────────────┘    │  对象存储 │
  x-tdai-service-id                              │               └──────────┘
  实现数据隔离                            ┌──────────────┐
                                         │    Redis     │
                                         │  状态 + 任务  │
                                         └──────────────┘
```

---

## Hermes 插件配置

提供两种 Hermes 插件，对应不同部署场景。

### v1 插件：`memory_tencentdb`（单机自管理）

自动启动并管理 Gateway 子进程，无需手动部署 Gateway。适用于单 Agent 本地/Docker 部署。

**安装插件**：

```bash
# 软链接（开发环境推荐）
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_tencentdb" \
      <hermes-agent>/plugins/memory/memory_tencentdb

# 复制（生产部署）
cp -r MemoryCore/hermes-plugin/memory/memory_tencentdb \
      <hermes-agent>/plugins/memory/memory_tencentdb
```

**Hermes 配置** (`~/.hermes/config.yaml`)：

```yaml
memory:
  provider: memory_tencentdb
```

**环境变量**：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TDAI_LLM_API_KEY` | (必填) | LLM API Key |
| `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API 地址 |
| `TDAI_LLM_MODEL` | `gpt-4o` | LLM 模型名 |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway 监听端口 |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway 监听地址 |
| `MEMORY_TENCENTDB_GATEWAY_CMD` | (自动检测) | 自定义 Gateway 启动命令 |

**工具列表**：

| 工具 | 用途 |
|------|------|
| `memory_tencentdb_memory_search` | 搜索 L1 结构化记忆 |
| `memory_tencentdb_conversation_search` | 搜索 L0 原始对话 |

**特性**：自动启动 Gateway 子进程、健康检查看门狗（10s 间隔）、自动恢复、熔断保护、后台 sync 线程。

---

### v2 插件：`memory_tencentdb_v2`（外部 Gateway）

连接已运行的 Gateway 服务（本地或远程），通过 v2 REST API 通信。适用于多 Agent 共享 Gateway、K8s 集群部署。

**安装插件**：

```bash
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_tencentdb_v2" \
      <hermes-agent>/plugins/memory/memory_tencentdb_v2
```

**安装 Python SDK**：

```bash
pip install tdai-memory
```

**Hermes 配置** (`~/.hermes/config.yaml`)：

```yaml
memory:
  provider: memory_tencentdb_v2
```

**环境变量**：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TDAI_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | Gateway 服务地址 |
| `TDAI_MEMORY_API_KEY` | `""` | Bearer Token（service 模式必填） |
| `TDAI_MEMORY_SERVICE_ID` | `""` | 实例/空间 ID（多租户隔离键） |

**工具列表**：

| 工具 | 用途 | 参数 |
|------|------|------|
| `tdai_memory_search` | 搜索 L1 结构化记忆 | `query`(必填), `limit`(默认 5) |
| `tdai_conversation_search` | 搜索 L0 原始对话 | `query`(必填), `limit`(默认 5) |
| `tdai_read_scene` | 读取 L2 场景内容 | `scene_id`(必填) |

**特性**：基于 `tdai_memory` Python SDK (httpx)、Bearer Token 认证、多租户隔离、熔断器（5 次失败 → 60s 冷却）、线程安全。

---

### 选择建议

| 场景 | 推荐插件 | 部署模式 | Gateway |
|------|----------|----------|---------|
| 本地开发 / 单 Agent | `memory_tencentdb` (v1) | standalone | 插件自动管理 |
| Docker 单容器 | `memory_tencentdb` (v1) | standalone | 插件自动管理 |
| 多 Agent 共享记忆 | `memory_tencentdb_v2` (v2) | service | 独立部署 |
| K8s 集群 | `memory_tencentdb_v2` (v2) | service | K8s Service |
| 多租户 SaaS | `memory_tencentdb_v2` (v2) | service | 多副本 + Redis |

---

## API 概览

### v1 API（Standalone 兼容）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/recall` | 记忆召回（prefetch） |
| POST | `/capture` | 对话捕获（sync_turn） |
| POST | `/search/memories` | L1 记忆搜索 |
| POST | `/search/conversations` | L0 对话搜索 |
| POST | `/session/end` | 会话结束 + 刷新 |
| POST | `/seed` | 批量导入历史对话 |

### v2 API（多租户，需 Bearer Token + x-tdai-service-id）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v2/conversation/add` | L0 添加对话 |
| POST | `/v2/conversation/query` | L0 查询对话 |
| POST | `/v2/conversation/search` | L0 搜索对话 |
| POST | `/v2/conversation/delete` | L0 删除对话 |
| POST | `/v2/atomic/add` | L1 添加记忆 |
| POST | `/v2/atomic/query` | L1 查询记忆 |
| POST | `/v2/atomic/search` | L1 搜索记忆 |
| POST | `/v2/atomic/delete` | L1 删除记忆 |
| POST | `/v2/scenario/ls` | L2 列出场景 |
| POST | `/v2/scenario/read` | L2 读取场景 |
| POST | `/v2/scenario/write` | L2 写入场景 |
| POST | `/v2/scenario/rm` | L2 删除场景 |
| POST | `/v2/persona/read` | L3 读取画像 |
| POST | `/v2/persona/write` | L3 写入画像 |

---

## 配置参考

### 全部环境变量

| 变量 | 默认值 | 适用模式 | 说明 |
|------|--------|----------|------|
| **Gateway 基础** |
| `TDAI_DEPLOY_MODE` | `standalone` | 全部 | `standalone` 或 `service` |
| `TDAI_GATEWAY_PORT` | `8420` | 全部 | 监听端口 |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | 全部 | 监听地址 |
| `TDAI_DATA_DIR` | `~/.memory-tencentdb/memory-tdai` | 全部 | 数据目录 |
| `TDAI_GATEWAY_CONFIG` | (搜索) | 全部 | 配置文件路径 |
| **LLM** |
| `TDAI_LLM_API_KEY` | `""` | 全部 | LLM API Key |
| `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | 全部 | LLM API 地址 |
| `TDAI_LLM_MODEL` | `gpt-4o` | 全部 | 模型名称 |
| `TDAI_LLM_MAX_TOKENS` | `4096` | 全部 | 最大输出 token |
| `TDAI_LLM_TIMEOUT_MS` | `120000` | 全部 | LLM 请求超时 |
| **Service 模式** |
| `STATE_BACKEND` | (auto) | service | `redis` 或 `local` |
| `REDIS_HOST` | `127.0.0.1` | service | Redis 地址 |
| `REDIS_PORT` | `6379` | service | Redis 端口 |
| `REDIS_PASSWORD` | (无) | service | Redis 密码 |
| `REDIS_KEY_PREFIX` | `tdai_memory` | service | Redis key 前缀 |
| **VDB（直连模式）** |
| `VDB_ENDPOINT` | `""` | service | VDB 地址 |
| `VDB_USER` | `root` | service | VDB 用户名 |
| `VDB_API_KEY` | `""` | service | VDB API Key |
| `VDB_DATABASE` | `default` | service | VDB 数据库名 |
| **COS（直连模式）** |
| `COS_SECRET_ID` | (无) | service | COS AK |
| `COS_SECRET_KEY` | (无) | service | COS SK |
| `COS_TOKEN` | (无) | service | COS STS Token |
| `COS_URL` | (无) | service | COS Bucket URL |
| `COS_PATH_PREFIX` | (无) | service | COS 路径前缀 |
| **Shark（生产模式）** |
| `SHARK_BASE_URL` | (无) | service | Shark 配置服务地址 |
| **调优** |
| `CONFIG_VDB_TTL_MS` | `300000` | service | VDB 配置缓存 TTL |
| `CONFIG_COS_BUFFER_MS` | `120000` | service | COS 凭证提前刷新 |
| `CONFIG_MAX_INSTANCES` | `1000` | service | 最大缓存实例数 |
| `SCANNER_SPACES` | `default` | service | Scanner 扫描空间列表 |
| `TDAI_SPACE_ID` | `default` | service | 当前空间 ID |

---

## 典型部署示例

### 示例 1：本地开发（最简）

```bash
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"
npx tsx src/gateway/server.ts
```

### 示例 2：Docker All-in-One（Hermes + Gateway）

```bash
docker run -d \
  -e MODEL_API_KEY="sk-xxx" \
  -e MODEL_BASE_URL="https://api.deepseek.com/v1" \
  -e MODEL_NAME="deepseek-chat" \
  -p 8420:8420 \
  -v hermes-data:/home/agentuser \
  agentmemory/hermes-memory:latest
```

### 示例 3：多 Agent + 共享 Gateway

```bash
# 1. 启动 Gateway（service 模式）
cd MemoryCore
TDAI_DEPLOY_MODE=service \
TDAI_GATEWAY_PORT=3100 \
TDAI_GATEWAY_HOST=0.0.0.0 \
STATE_BACKEND=local \
VDB_ENDPOINT="http://vdb.example.com:8100" \
VDB_API_KEY="your-key" \
VDB_DATABASE="memory-shared" \
npx tsx src/gateway/server.ts

# 2. 每个 Hermes Agent 配置不同的 service_id
# Agent A:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-code-assistant"

# Agent B:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-customer-support"
```

### 示例 4：K8s 生产部署

本仓库当前未提交可直接应用的 Kubernetes manifests；请使用本节的 Deployment、ConfigMap 和 Secret 示例作为配置模板，并按实际镜像、域名和集群环境调整。

---

## 端到端验证（E2E）

仓库提供两份开箱即用的 E2E 脚本，分别覆盖两种部署形态。它们都基于真实的 Hermes API Server + 真实 LLM + 真实 Gateway 进程，跑通整条链路。

### Standalone E2E：`__tests__/e2e/test_hermes_standalone_e2e.py`

验证开源单机部署链路：

```
Hermes API Server → memory_tencentdb (v1 plugin) → 自管理 Gateway 子进程 → SQLite + 本地 FS
```

覆盖项：
- Hermes API Server 启动、`/health` 通过
- 首次 chat 触发 v1 插件 `initialize()`，自动 `pnpm exec tsx src/gateway/server.ts` 拉起 Node 子进程
- Gateway `/health` 报告 `vectorStore: true`
- 3 轮对话：植入 marker → 模型回忆并回显 → 跨 session 通过 v1 plugin prefetch 召回
- Side-channel：直连 Gateway `/search/conversations` 查到本次 run 的 marker
- 工具层：`/search/conversations` / `/search/memories` 正常响应

```bash
hermes-agent/.venv/bin/python MemoryCore/__tests__/e2e/test_hermes_standalone_e2e.py
```

实测结果：**16 / 16 passed**。

### Service E2E：`MemoryCore/__tests__/e2e/test_hermes_service_e2e.py`

验证云服务化多副本部署链路：

```
mock-shark (Shark stub: 提供 VDB/COS 配置)
2 个 Gateway 进程（service mode，共享 TCVDB）
Hermes → memory_tencentdb_v2 (v2 plugin, tdai_memory SDK) → Gateway-1 → TCVDB
Side-channel 在 Gateway-2 验证 → 证明 TCVDB 真共享
```

覆盖项：
- mock-shark + GW1 + GW2 + Hermes 全部就绪
- 两个 Gateway 都是 service 模式（`stateBackend=connected` + `timerScanner` 运行中）
- Hermes `/v1/models` 返回 200，v2 plugin 加载成功
- 3 轮对话通过 v2 plugin 写入 GW1 → 真实 TCVDB
- **跨 Gateway 一致性**：GW2 search 能找到 GW1 写入的 marker
- GW2 `/conversation/query` 拉到主 session 的全部消息
- 跨 session prefetch：模型在新 session 中通过 v2 plugin 召回 marker
- L1 add on GW1 → GW2 `/atomic/query` 立即可见（证明 TCVDB 共享读写）
- 自动备份/还原 `~/.hermes/config.yaml` 的 `memory.provider` 字段

```bash
# 前置：安装 SDK 到 Hermes venv（一次性）
hermes-agent/.venv/bin/python -m pip install -e sdk/memory-core/python/

# 运行
hermes-agent/.venv/bin/python __tests__/e2e/test_hermes_service_e2e.py
```

实测结果：**23 / 23 passed**（跨 Gateway 一致性、跨 session 召回、L1 跨 GW 共享全部通过）。

### 两个脚本的共同前置条件

1. `hermes` CLI 已安装（默认路径 `~/.hermes/bin/hermes`）
2. `~/.hermes/config.yaml` 中 `model.api_key` / `model.base_url` / `model.default` 配置了可用的 LLM
3. v1 / v2 插件已链接到 `hermes-agent/plugins/memory/`（默认已安装）
4. Service 模式额外需要：`pnpm add cos-nodejs-sdk-v5`（Gateway 依赖）+ `pip install -e sdk/memory-core/python/`（Hermes 用 SDK）
