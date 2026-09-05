# TDAI 全局镜像本地部署

全局三件套镜像的本地拉起脚本 —— `memory-core` + `memory-hub` + `proxy`，可各自独立运行，也能一条命令全部启动。

## 组件与端口

| 组件 | 容器名 | 镜像（Docker Hub 公开） | 宿主机端口 | 用途 |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | 内核 gateway，记忆读写、鉴权、skill/RAG 数据面 |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | 管理面板 (Panel) + 知识服务 (Knowledge) 合并镜像 |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM 请求转发代理，coding agent 的 API 入口 |

> 三个镜像都发布在 Docker Hub 的 [`agentmemory`](https://hub.docker.com/u/agentmemory) 命名空间下，
> 多架构（`linux/amd64` + `linux/arm64`），公开可拉、无需登录。想固定版本时把 `.env` 里的 tag 从
> `:latest` 换成具体版本即可，例如 `:1.0.0-beta.1`。
>
> 腾讯内部同事也可以覆盖到内网私仓 `mirrors.tencent.com/memory-team-control/` —— 见 `.env.example` 里
> 注释掉的备选块。

## 环境要求

- macOS / Linux
- Docker（Docker Desktop / colima / OrbStack 任一）
- `bash` 4+（macOS 自带 3.2 也能跑）

## 快速开始

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# 一条命令：自动复制 .env → 交互式填 LLM → 自动校验通路 → 拉起三件套
./start-all.sh
```

`start-all.sh` 现在是**交互式**的，运行时会：

1. `.env` 不存在时，自动从 `.env.example` 复制一份（无需手动 `cp`）
2. 引导你填写两组 LLM（**回车 = 保留当前默认值**）：
   - `memory 组`：`BASE_URL` / `API_KEY` / `MODEL`（协议默认 `openai`）
   - `proxy 组`：先问「是否复用 memory 组配置」，复用则跳过
3. 填完**立即检查 LLM 通路是否通**，不通会提示重新输入，直到通过
4. 把填写值**写回 `.env`** 持久化（下次启动默认复用）
5. 通过后一键拉起三件套

> 想跳过交互、直接读 `.env` 也可以：手动 `cp .env.example .env` 并填好 LLM 后，
> 运行 `./start-all.sh` 一路回车确认即可（默认值就是 `.env` 里的值）。

### 干跑校验（可选）

`verify.sh` 仍可单独使用，只检查环境不启动容器：

```bash
./verify.sh              # 默认全检（含 LLM 通路预检）
./verify.sh --skip-llm   # 跳过 LLM 检查（离线环境）
```

## LLM 通路预检

`verify.sh` 默认会预检两组 LLM 通路（`--skip-llm` 关掉）：

- **OpenAI 兼容协议**：`GET {base}/models`，只验证 API key + URL，**不消耗任何 token**
- **Anthropic 协议**：`POST {base}/v1/messages` 发 `max_tokens=1` 的最小消息，消耗 ≤ 10 token
- **memory 组** 与 **proxy 组** 独立验；若两组配置完全相同，自动跳过重复检查
- **容器已运行时**，额外从容器内 exec 一次 curl，验证"容器 → LLM"的网络可达性（一些企业代理/DNS 隔离环境下宿主机可达但容器不可达）

失败例子：

```
[error] memory 组 API key 无效（HTTP 401）：https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

—— API key 错、URL 错、模型名错都会在启动前拦下，不会等到 wiki ingest / chat 时才 401。

启动完成后：

- Panel UI：<http://localhost:8125/>
- Knowledge API：<http://localhost:8424/v3/>
- Knowledge Swagger：<http://localhost:8424/docs>
- Memory Gateway：<http://localhost:8420/>
- Proxy：<http://localhost:8096/>

## 两组独立参数

**这是脚本设计的核心** —— memory 组和 proxy 组的 LLM 完全独立，可以指向不同供应商 / 不同模型。

### memory 组（memory-core + memory-hub 使用）

内核记忆 embed/summarize、knowledge 的 wiki ingest / 总结走这组配置。

| 变量 | 说明 | 示例 |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容 base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | 上述端点的 API Key | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | 模型 ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` 或 `anthropic`，默认 `openai` | `openai` |

### proxy 组（proxy 使用）

proxy 接到用户请求后转发到这组端点。

| 变量 | 说明 | 示例 |
|---|---|---|
| `PROXY_UPSTREAM_URL` | 转发目标 base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | 转发用 API Key | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | 面向用户的模型 ID | `deepseek-chat` |

> 两组可以填相同值（都指向同一个 LLM），也可以完全不同：例如 memory 组用便宜模型做 embedding，proxy 组用强模型做主对话。

参数缺失时脚本会**在启动前一次性列出所有缺失项**并 `exit 1`，不会跑到一半才失败。

## Agent 主动工具地址

### 浏览器会话初始化地址

反向代理、公网域名或 TLS termination 场景应显式设置
`PROXY_SESSION_INIT_PUBLIC_BASE_URL=https://memory.example.com`，部署脚本将其写入
`sessionInit.webPublicBaseUrl`。该地址供**浏览器打开 Web Init**，与下面供
**Agent 执行主动工具**的 `PROXY_EXTERNAL_GATEWAY_URL` 独立，可以不同。
如代理挂载在子路径，可填写 `https://memory.example.com/proxy` 并转发其下的
`/session-init/**` 到 Proxy。只允许 HTTP(S)，拒绝凭据、查询串和片段，末尾 `/` 会去除。

未配置时保留直接访问的 request origin，便于本地部署；不要将此 fallback 当成
外部地址自动发现。显式配置不会被 Host、X-Forwarded-Host 或 X-Forwarded-Proto 覆盖。

### Agent 工具地址

`PROXY_EXTERNAL_GATEWAY_URL` 是**从 Agent 实际执行主动工具的环境中可以访问的
MemoryProxy 基础地址**。非空时，`start-proxy.sh` 将其写入生成配置的
`injection.externalGatewayUrl`，供主动 Memory / Skill 工具使用；未设置或留空时
不生成该字段，保留现有 fallback。此变量与 `MEMORY_HUB_PROXY_PUBLIC_URL`
（仅供 Panel 展示）独立，不从 Host、X-Forwarded-Host 或 Docker 容器 IP 推导。

| Agent 实际工具环境 | 候选值示例 | 验证位置 |
|---|---|---|
| Proxy 所在宿主机 | `http://localhost:8096` | 宿主机的 Agent Bash |
| 同一局域网另一台机器 | `http://192.168.1.100:8096` | 另一台机器的 Agent Bash |
| 通过域名访问 | `https://memory.example.com` | Agent 实际运行环境 |
| 与 Proxy 在同一 Docker 网络 | `http://proxy:8096` | 执行工具的容器内部 |

这些只是候选值，不是自动默认值。端口映射变化时使用实际宿主机端口；同 Docker
网络使用容器监听端口。不要附加 `/openclaw/default/v1` 等客户端路径，也不要
包含凭据、查询串或片段。反向代理需转发 `/memory-bridge/**` 和 `/skill-bridge/**`。

先从实际工具环境检查候选地址（部署机能访问不代表 Agent 能访问）：

```bash
PROXY_CANDIDATE=http://localhost:8096  # 按实际拓扑替换
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  "${PROXY_CANDIDATE}/health"
```

确认是预期 Proxy 的健康响应后，在有管理权限的部署目录 `.env` 中设置
`PROXY_EXTERNAL_GATEWAY_URL`，再运行 `./start-proxy.sh` 重新生成配置并启动。
已有完整流水线应保留 `PROXY_FULL_STACK=1` 或原有能力开关。健康检查只证明网络
连通，还需在已绑定会话中调用主动 Memory 查询，确认身份和业务路径正常。
远端 Proxy 无管理权限时，只向部署管理员提供已验证的候选值，不擅自修改远端环境。

配置生成与兼容性测试（不需要真实 Docker）：

```bash
npm --prefix ../../MemoryProxy test -- src/config/__tests__/deployment.test.ts
```

OpenClaw 推荐安装 [Session Bridge](../../agents/openclaw/README.md)，使用 Web Init
选择 Team / Agent 和可选 Task；旧静态 header 预选仍可用。

## 内部凭据（生产环境必看）

三件套之间用 `MEMORY_CORE_GATEWAY_API_KEY` 互相认证，首次启动还会通过
`init-admin` 建一个 `system_admin` 账户。为了**零配置本地体验**，脚本默认值是：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | memory-hub / proxy → memory-core 的 Bearer |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | 初始化的 system_admin 用户名 |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | 该 admin 用户的登录 key |

> 这三个默认值只适合个人本地跑通流程。**生产/联调/公网暴露前必须替换成随机长串**，
> 否则任何拿到端口的人都能拿到 system_admin 权限。
>
> 在 `.env` 里取消对应三行的注释并覆盖即可（`_lib.sh` 会 `require_vars`
> 校验其他必填项，但这三个变量因为有默认兜底，脚本会在启动时打 `[warn]` 提醒你换）。

## 独立使用每个组件

三个脚本可以单独执行，方便调试或只需要部分能力时：

```bash
./start-memory-core.sh       # 只跑内核 gateway（8420）
./start-memory-hub.sh   # 只跑面板 + 知识（8125 + 8424）；需要 MEMORY_LLM_* 参数
./start-proxy.sh        # 只跑 proxy（8096）；需要 PROXY_UPSTREAM_* 参数
```

依赖关系：

- **memory-core**：无外部依赖，可以独立起
- **memory-hub**：能独立启动（LLM_MODE=custom 直连 LLM），但内部 knowledge 调 memory-core 做 RAG 时会失败 → 建议 memory-core 先起
- **proxy**：能独立启动（cost-guard 不可用时自动降级 passthrough，直接转发），但 auth / tdai memory / skill 注入需要 memory-core 才有效

任意组件缺失时脚本会 `warn` 提醒但不阻塞。

## 数据持久化

- `tdai-memory-core-data`（named volume）→ memory-core 的 SQLite / 记忆数据
- `tdai-panel-data`（named volume）→ memory-hub 里 knowledge 的 SQLite / git clone / wiki 文件

`docker volume rm` 之前数据一直保留。改名可在 `.env` 里改 `MEMORY_CORE_VOLUME` / `PANEL_VOLUME`。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume（下次启动数据还在）
./stop-all.sh --purge    # 停容器 + 删 volume + 删网络（彻底清理）
```

## 查看日志

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub 内部有两个进程（panel + knowledge），日志分别在容器内 `/data/knowledge/logs/panel.log` 和 `.../knowledge.log`。

## 端口冲突

如果 `8125` / `8420` / `8424` / `8096` 与本地已有服务冲突，直接在 `.env` 改：

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# knowledge 对外可达地址要跟着 KNOWLEDGE_PORT 走
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## 使用 proxy 作为 coding agent 的 API base

以 Claude Code 为例：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# 使用 openai 协议的客户端类似：OPENAI_BASE_URL=http://localhost:8096/v1
```

Panel UI "客户端接入地址" 卡片会自动拼上宿主机的 LAN IP + `PROXY_PORT`（例如
`http://192.168.1.100:8096/codebuddy/default`），别人的电脑复制过去就能直接连过来。
由 `MEMORY_HUB_PROXY_PUBLIC_URL`（未设时脚本用 `hostname -I` / macOS `ipconfig getifaddr en0`
自动探测，探不到才回落 `localhost`）注入到 memory-hub 里的 `metadata-instances.json.proxy_endpoint`。
Panel 后端 → Kernel 的转发不受此变量影响（始终走 `REMOTE_INSTANCE_URL` → memory-core:8420）。
自动探测的地址不对时（多网卡 / 公网域名 / 反代前置），在 `.env` 显式设
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<真值>:8096`。想让 UI 卡片走老行为（回落到
gateway_endpoint）就把 `MEMORY_HUB_PROXY_PUBLIC_URL` 显式设为空字符串。

`proxy` 默认关闭 `auth` / `sessionInit` / `costGuard`（这些依赖内部服务），只做纯转发 + `tdai-memory` 上下文注入（injector 名称，非容器名）。要开启完整流水线，需要另行配置 —— 参见 `context_proxy/config.example.yaml`。

## 常见问题

**Q: `./start-all.sh` 卡在 wait_healthy？**
镜像可能还在拉取。用 `docker pull <IMAGE>` 手动预拉一次再跑脚本。

**Q: memory-hub 起来但 Panel 打不开？**

检查 `.env` 里 `KNOWLEDGE_PUBLIC_BASE_URL` 是不是含 `/v3` —— 缺 `/v3` panel 会报错。

**Q: proxy 转发返回 401？**
`PROXY_UPSTREAM_API_KEY` 无效或 `PROXY_UPSTREAM_URL` 不匹配。用 `docker logs tdai-proxy` 看错误。

**Q: 如何在容器外访问宿主机上其它服务（Ollama、Langfuse 等）？**
脚本已默认 `--add-host=host.docker.internal:host-gateway`。容器内用 `http://host.docker.internal:<port>` 即可。
