# Hermes + TDAI Memory — 一体化开源镜像

预装 Hermes Agent + TDAI Memory 插件，单容器同时运行两个服务。
只需配置一个 API Key 即可启用 Hermes 对话 + 四层记忆系统。

## 架构

```
┌──────────────────────────────────────────────────────┐
│                     容器内部                          │
│                                                      │
│  ┌──────────────────────┐    ┌─────────────────────┐ │
│  │  Hermes Agent        │    │  TDAI Memory        │ │
│  │  (Python)            │───▶│  Gateway (Node.js)  │ │
│  │                      │HTTP│  :8420              │ │
│  │  memory_tencentdb    │    │                     │ │
│  │  plugin (内置)       │    │  SQLite 本地存储     │ │
│  └──────────────────────┘    └─────────────────────┘ │
│                                                      │
│  统一模型配置（Hermes + TDAI 共用一套 MODEL_* 变量） │
└──────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 创建本地环境变量文件，并填入 MODEL_API_KEY
cp .env.example .env
$EDITOR .env

# 构建并启动（后台常驻，Gateway 自动启动）
docker compose up -d --build

# 验证 Gateway
curl http://localhost:8420/health

# 进入 Hermes 对话
docker compose exec hermes-memory hermes

# 查看状态和日志
docker compose ps
docker compose logs -f hermes-memory

# 停止服务；如需同时删除记忆数据，追加 -v
docker compose down
```

> 镜像内置了腾讯云 DeepSeek-V3.2 的默认值，如果你使用该模型，只需要在 `.env` 中设置 `MODEL_API_KEY`。

也可以直接使用 Docker 运行同一个镜像：

```bash
docker build -f Dockerfile.hermes -t hermes-memory .

docker run -d \
  --name hermes-memory \
  --restart unless-stopped \
  -p 8420:8420 \
  -e MODEL_API_KEY="your-api-key" \
  -e MODEL_BASE_URL="https://api.lkeap.cloud.tencent.com/v1" \
  -e MODEL_NAME="deepseek-v3.2" \
  -e MODEL_PROVIDER="custom" \
  -v hermes_data:/opt/data \
  hermes-memory

# 验证 Gateway
curl http://localhost:8420/health

# 进入 Hermes 对话
docker exec -it hermes-memory hermes
```

## 工作原理

容器启动时（`CMD`）自动执行以下步骤：

1. 将 `MODEL_*` 环境变量同步到 Gateway（`export TDAI_LLM_*`）
2. 生成 `/opt/data/config.yaml`（Hermes 配置，含模型参数和 `memory.provider: memory_tencentdb`）
3. 生成 `/opt/data/.env`（写入 `OPENAI_API_KEY`，供 Hermes 读取）
4. 前台启动 TDAI Memory Gateway（Node.js，监听 :8420，保持容器常驻）

通过 `docker exec -it hermes-memory hermes` 进入对话时，Hermes 从 `$HERMES_HOME`（`/opt/data`）读取上述配置文件，自动连接已运行的 Gateway。memory_tencentdb 插件通过 HTTP 与本地 Gateway 通信，完成对话采集、记忆提取、场景构建和用户画像生成（L0→L1→L2→L3 四层 pipeline）。

## 环境变量

### 统一模型配置（Hermes + TDAI 共用）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MODEL_API_KEY` | - | LLM API Key（**必填，运行时通过 `-e` 传入**） |
| `MODEL_BASE_URL` | `https://api.lkeap.cloud.tencent.com/v1` | LLM API 地址 |
| `MODEL_NAME` | `deepseek-v3.2` | 模型名称 |
| `MODEL_PROVIDER` | `custom` | 模型 provider: custom/openrouter/anthropic/openai/gemini |

用户只需配置上述 `MODEL_*` 变量，容器启动时自动同步到 Hermes（`config.yaml` + `.env`）和 Gateway（`TDAI_LLM_*` 环境变量）。

Compose 默认读取同目录的 `.env` 文件。不要提交 `.env`；提交和分享配置时使用 `.env.example`。

### 服务配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TDAI_GATEWAY_PORT` | `8420` | Gateway 端口 |
| `TDAI_GATEWAY_HOST` | `0.0.0.0` | Gateway 绑定地址 |
| `TDAI_DATA_DIR` | `/opt/data/tdai-memory` | 记忆数据目录 |
| `HERMES_HOME` | `/opt/data` | Hermes 数据目录 |
| `TDAI_GATEWAY_API_KEY` | - | 可选 Gateway Bearer token；设置后除 `/health` 外的接口需要鉴权 |
| `TDAI_CORS_ORIGINS` | - | 可选浏览器 CORS 白名单，多个 origin 用逗号分隔 |

## 数据持久化

所有数据存储在 `/opt/data` volume 中：

```
/opt/data/
├── tdai-memory/          # TDAI 记忆数据 (SQLite + 场景文件)
│   ├── memories.sqlite   # L0/L1 数据
│   ├── scene_blocks/     # L2 场景文件
│   ├── persona.md        # L3 用户画像
│   └── checkpoint.json   # Pipeline 状态
├── sessions/             # Hermes 会话记录
├── skills/               # Hermes 技能
├── config.yaml           # Hermes 配置（启动时自动生成）
└── .env                  # 环境变量（启动时自动生成）
```

Gateway 日志写到容器 stdout / stderr，用 `docker compose logs -f hermes-memory` 查看。

## 故障排查

```bash
# 查看 Gateway 日志
docker compose logs -f hermes-memory

# 查看 Gateway 健康状态
docker compose exec hermes-memory curl -s http://localhost:8420/health | python3 -m json.tool

# 手动测试记忆召回
docker compose exec hermes-memory curl -s -X POST http://localhost:8420/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"test","session_key":"debug"}'

# 如果设置了 TDAI_GATEWAY_API_KEY，带 Bearer token 测试受保护接口
docker compose exec hermes-memory sh -lc 'curl -s -X POST http://localhost:8420/recall \
  -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"test\",\"session_key\":\"debug\"}"'

# 查看生成的 Hermes 配置
docker compose exec hermes-memory cat /opt/data/config.yaml

# 查看环境变量同步结果
docker compose exec hermes-memory env | grep -E '(MODEL_|TDAI_LLM_)'

# 进入容器调试
docker compose exec hermes-memory bash
```

## 构建说明

Dockerfile 不依赖本地源码 COPY，也不依赖 root 用户：

- **TDAI Memory Gateway**：通过 `npm install @tencentdb-agent-memory/memory-tencentdb@latest` 从 npm registry 获取
- **Hermes Agent**：通过官方安装脚本从 GitHub 获取，安装到 `/usr/local/lib/hermes-agent/`
- **memory_tencentdb 插件**：npm 包内已包含 `hermes-plugin/` 目录，构建时自动 symlink 到 Hermes 内置插件路径（`/usr/local/lib/hermes-agent/plugins/memory/`）

容器内所有运行时路径均为绝对路径，不依赖 `$HOME` 或特定用户，可以非 root 用户运行。
