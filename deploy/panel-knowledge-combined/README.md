# Memory Hub

**Memory Hub** 是一个合并镜像：一个容器内同时运行两个服务——Team Memory Control（Panel）和 Knowledge Service（KS）。

- **Panel**：管理团队 / Agent / Knowledge 资源的控制台
- **KS**：Wiki / Code Graph 知识服务，供 Agent 通过 tools 调用

镜像发布在 Docker Hub：[`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)（推荐拉取 `latest`）。

---

## 前置准备

### 1. 实例配置文件

在云上购买 Memory 实例后，你会拿到**实例 ID**、**Gateway 地址**和 **API Key**。写入一个 JSON 文件（例如 `metadata-instances.json`）：

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "我的 Memory 实例",
      "gateway_endpoint": "https://memory.ap-shanghai.tencenttdai.com",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

`gateway_endpoint` 填控制台给你的 Gateway 地址（上例仅为上海地域示例，按实际地址填写）。多实例就往 `instances` 数组里加多个对象。

### 2. KS 外部可达地址

KS 需要对外暴露一个地址，让 Agent（以及云上 Gateway）能访问 KS 的 tools 接口。这个地址**必须是外部能访问的**（不能用 `127.0.0.1` / `localhost`），且**必须含** `/v3`。

例如宿主机公网/内网 IP 为 `10.2.3.4`、端口映射 `8424`，则：

`http://10.2.3.4:8424/v3`

### 3. LLM Proxy 地址

KS 的 Wiki ingest / 总结等能力会调用大模型，默认走 Memory 提供的 LLM 转发能力。

`KNOWLEDGE_LLM_PROXY_BASE_URL` 与上面的 `gateway_endpoint` **是同一个地址**：从 Memory 控制台拿到的 Gateway 地址。例如上海地域：

`https://memory.ap-shanghai.tencenttdai.com`

（其它地域按控制台实际地址填写。）

若要改用自有 LLM 端点，见下方 [Custom 模式](#custom-模式直连-llm不走-proxy)。

---

## 快速启动

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=https://memory.ap-shanghai.tencenttdai.com \
  agentmemory/memory-hub:latest
```

> 将 `/path/to/metadata-instances.json`、`10.2.3.4`（KS 外部地址）以及 `KNOWLEDGE_LLM_PROXY_BASE_URL`（与 `gateway_endpoint` 相同，按控制台实际 Gateway 地址填写）换成你的实际值。

### 必填项（只有这 3 项）

| 配置 | 方式 | 说明 |
| --- | --- | --- |
| 实例配置 | 挂载 `metadata-instances.json` | 云上 Memory 实例的 ID、Gateway 地址、API Key |
| KS 外部地址 | `KNOWLEDGE_PUBLIC_BASE_URL` | 外部能访问到 KS 的地址，**必须含** `/v3` |
| LLM Proxy 地址 | `KNOWLEDGE_LLM_PROXY_BASE_URL` | 与 `gateway_endpoint` 相同，填 Memory 控制台的 Gateway 地址 |

以上 3 项必须由用户提供，其余配置均有镜像内置默认值，按需调整即可。

---

## 可选配置

### 知识卡评测中心（Recorded E1 Demo）

镜像默认 COPY `GLOBAL_SYNTHETIC` 合成 Bundle，并在启动时校验 producer 原始字节的独立 SHA-256 pin。该页面只展示 Recorded E1 Fixture，知识卡均为 `DISPLAY_ONLY`；`runExposure=NOT_PROVEN`，不表示真实 Agent 执行、线上收益或 E2 通过。

可使用两份只读挂载覆盖默认资产（必须成对更新），并把构建期验证得到的新摘要显式设为运行时权威：

```bash
-v /path/evaluation-view-bundle.json:/app/evaluation/bundle/evaluation-view-bundle.json:ro \
-v /path/evaluation-view-bundle.sha256:/app/evaluation/pin/evaluation-view-bundle.sha256:ro \
-e EVALUATION_BUNDLE_EXPECTED_SHA256=sha256:<new-bundle-64hex>
```

运行时摘要权威来自镜像 metadata / 服务端环境变量 `EVALUATION_BUNDLE_EXPECTED_SHA256=sha256:<64hex>`，而不是与 Bundle 同目录、可能被一起替换的 sidecar。sidecar 只作为 producer/构建期输入；运行时 Bundle 即使与 sidecar 同时被替换，仍会因不匹配固定期望摘要而 fail-closed。

可选环境变量：`EVALUATION_BUNDLE_ENABLED`、`EVALUATION_BUNDLE_PATH`、`EVALUATION_BUNDLE_EXPECTED_SHA256`、`EVALUATION_BUNDLE_MAX_BYTES`。资产缺失或摘要不一致时，仅 `/api/v1/evaluation/*` 返回 503，Panel/Knowledge 健康检查和其他功能继续可用。

以下配置都有镜像内置默认值，不传也能正常工作。按需覆盖即可。

### LLM 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | LLM 协议：`openai` 走 `/chat/completions`，`anthropic` 走 `/messages` |
| `LLM_MODEL` | `Memory-Model` | 模型 ID，透传到 proxy/TokenHub |
| `LLM_MODE` | `proxy` | `proxy`：走 Memory Gateway LLM 转发；`custom`：直连 BYO 端点 |
| `LLM_MAX_TOKENS` | `32768` | 单次 LLM 调用最大输出 token |
| `LLM_TIMEOUT_MS` | `1200000` | LLM 调用超时 ms（20 分钟，reasoning 模型需要较长时间） |
| `LLM_API_KEY` | 空 | 仅 `LLM_MODE=custom` 时必填 |
| `LLM_BASE_URL` | 空 | 仅 `LLM_MODE=custom` 时必填，如 `https://api.openai.com/v1` |

**协议与模型配套规则**：

| 协议 | 适用模型 | 端点 |
| --- | --- | --- |
| `openai`（默认） | `Memory-Model`、`deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`、`claude-sonnet-4-5` 等 | `/messages` |

切换模型时协议必须配套：

```bash
# 默认（OpenAI 协议 + Memory-Model）
# 不需要额外配置，镜像默认就是

# 切换到 Anthropic 模型
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

### 网络与存储

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel 服务端口 |
| `KNOWLEDGE_PORT` | `8424` | KS 服务端口 |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS 数据目录（SQLite、git clone、wiki 文件、日志） |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite 数据库路径 |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | KS ingest 完成回调 Panel 的根地址（容器内自动回环，一般不用改） |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Panel 调 KS 的请求超时 |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Panel 调远端 Gateway 的请求超时 |
| `REMOTE_INSTANCE_PROXY_URL` | 空 | Panel UI "客户端接入地址"卡片显示的 base URL。开源本地部署 core+proxy 分开跑时填 proxy 的外部地址（如 `http://host.docker.internal:8096`），Panel UI 复制的 CodeBuddy/ClaudeCode 接入地址就会指向 proxy。留空则老行为 —— UI 回落到 `gateway_endpoint`。**Panel 后端 → Kernel 的转发始终走 `REMOTE_INSTANCE_URL`，与此变量无关。**（挂载了 `metadata-instances.json` 时忽略此变量，直接在 JSON 里加 `proxy_endpoint` 字段） |

### TLS 证书

公网正式证书一般无需额外配置。当 LLM Proxy 或 Gateway 使用 HTTPS 且证书不被容器信任时（如自签名证书、内部 CA），有两种方式解决：

**方式 A：跳过 TLS 验证（快速测试用，不推荐生产）**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**方式 B：挂载 CA 证书（推荐）**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | 未设置 | 设为 `0` 跳过 TLS 证书验证（仅测试用） |
| `NODE_EXTRA_CA_CERTS` | 未设置 | 附加 CA 证书路径，Node.js 原生支持，AI SDK 的 fetch 也会读取 |

### 日志

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别（`debug` / `info` / `warn` / `error`） |
| `LOG_FORMAT` | `json` | 日志格式（`json` / `text`） |
| `LOG_DIR` | `/data/knowledge/logs` | 日志文件目录 |

日志落文件到 `${LOG_DIR}/panel.log` 和 `${LOG_DIR}/knowledge.log`，每次启动轮转一份 `.prev`，同时输出到 stdout（`docker logs` 可见）。

### 可观测性（Langfuse）

三个都配置后，KS 的 LLM 调用会自动上报 trace 到 Langfuse。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | 空 | Langfuse 服务地址 |
| `LANGFUSE_PUBLIC_KEY` | 空 | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | 空 | Langfuse secret key |

### LLM Binding 同步

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | Panel 启动时是否为实例同步 KS llm_binding。`LLM_MODE=proxy` 时强制为 `1`；`custom` 模式下设 `0` 让 KS 走全局配置 |

---

## 访问地址

| 服务 | 地址 |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS Health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger 文档 | `http://localhost:8424/docs` |

---

## Custom 模式（直连 LLM，不走 Proxy）

若不用 Memory Gateway 的 LLM 转发，可直接指定自有 LLM 端点。此时不需要 `KNOWLEDGE_LLM_PROXY_BASE_URL`。

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## 数据持久化

| 挂载点 | 说明 |
| --- | --- |
| `/data/knowledge` | KS 数据（SQLite、git clone、wiki 文件、日志） |

建议用 named volume：`-v memory-hub:/data/knowledge`（与容器名一致）。

---

## 常见问题

### Q: 容器内访问宿主机服务？

云上 Gateway（`KNOWLEDGE_LLM_PROXY_BASE_URL`）一般可直接访问，无需改成宿主机地址。若其它服务（如 Langfuse）跑在宿主机上，用 `172.17.0.1`（docker0 网桥）代替 `localhost`：

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

或加 `--add-host=host.docker.internal:host-gateway` 用 `host.docker.internal`。

### Q: wiki ingest 报 timeout？

reasoning 模型对大文件可能需要超过 20 分钟：

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 分钟
```

### Q: tools/list 返回 404？

`KNOWLEDGE_PUBLIC_BASE_URL` 必须包含 `/v3` 前缀。正确格式：`http://host:port/v3`。

### Q: 切换 LLM 协议后报错？

确保 `LLM_PROTOCOL` 和 `LLM_MODEL` 配套：

```bash
# OpenAI 模型（默认）
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic 模型
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

## 构建

### 前置条件

源码均在本仓库根目录下：

```text
memory-tencentdb/
├── MemoryPanel/                         # Panel 后端 + web 前端
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # 本配方
```

### 本地单架构构建（调试用）

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # 默认 linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # 本机若是 arm64 可直接编
```

### 发布到 Docker Hub（amd64 + arm64）

Tag 约定：

| Tag | 含义 |
| --- | --- |
| `1.0.0-beta.N` | 钉死版本（文档/复现用这个） |
| `beta` | 浮动频道：始终指向当前最新 beta（默认随发布一起推） |
| `latest` | 正式稳定版再用（默认不推） |

首发建议推：`agentmemory/memory-hub:1.0.0-beta.1` + `agentmemory/memory-hub:beta`。

```bash
cd deploy/panel-knowledge-combined

# 1) 已登录 Docker Hub（需 agentmemory org 推送权限）
docker login

# 2) 只扫敏感信息 + 准备 context（不构建）
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) 可选：先本地 load amd64，抽查镜像层里没有 .env / metadata-instances.json
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) 正式双架构构建并推送（默认同时打 :beta）
VERSION=1.0.0-beta.1 ./publish.sh

# 只要版本 tag、不挪 :beta：
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# 正式版再打 latest（beta 阶段不要开）：
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` 会依次：

1. 对 `MemoryPanel` / `MemoryKnowledge` 跑 `scripts/secret-scan.sh`
2. `PREPARE_ONLY=1 ./build.sh` 生成 rsync context（已排除 `.env*`、`metadata-instances.json` 等）
3. 再扫一遍 context
4. `docker buildx build --platform linux/amd64,linux/arm64 --push` 到 `agentmemory/memory-hub:<VERSION>`（默认再打 `:beta`；本地名 `team-memory-panel-knowledge` 只用于 `PUSH=0`，不会 push）

推送后自检：

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# 两者应看到 Platform: linux/amd64 与 linux/arm64，且 digest 一致
docker pull agentmemory/memory-hub:beta
```

环境变量速查：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | 版本 tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | 仓库名 |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx 目标 |
| `BUILDER` | `multiarch` | buildx builder 名（不存在则自动 create） |
| `DRY_RUN` | `0` | `1` = 只扫描 |
| `PUSH` | `1` | `0` = 本地 `--load` 单架构 |
| `ALSO_BETA` | `1` | `1` = 额外推浮动 `:beta` |
| `ALSO_LATEST` | `0` | `1` = 额外推 `:latest` |
