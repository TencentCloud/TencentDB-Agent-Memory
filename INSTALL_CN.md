# TencentDB Agent Memory 安装指南（简体中文）

← 返回 [README_CN.md](./README_CN.md) · English: [INSTALL.md](./INSTALL.md)

本文覆盖三种安装形态：
1. **完整三件套**：`memory-core` + `memory-hub` + `proxy` 一键起（推荐，能让 Claude Code 之类的 coding agent 直接用上团队记忆 / 知识 / skill 注入）
2. **只装 Memory Hub**：已有 Memory Core 运行在本机时的轻量部署
3. **通过 Proxy 使用 Claude Code**：把 coding agent 挂到 proxy 上

---

## 完整三件套：Memory Core + Memory Hub + Proxy（推荐）

一次拉起 `memory-core` + `memory-hub` + `proxy`，并通过 `proxy` 让 Claude Code
之类的 coding agent 直接用上团队记忆 / 知识 / skill 注入：

```bash
# 1) 拿脚本
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images

# 2) 准备 .env（把 LLM 相关字段填成真值）
cp .env.example .env
$EDITOR .env
#   MEMORY_LLM_BASE_URL   / MEMORY_LLM_API_KEY   / MEMORY_LLM_MODEL     ← memory + hub 内部用
#   PROXY_UPSTREAM_URL    / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL ← proxy 转发到的上游

# 3) 干跑校验（可选；会真做 LLM 通路预检，加 --skip-llm 跳过）
./verify.sh

# 4) 一键起
./start-all.sh
```

启动完成后脚本会自动：

1. 首次启动时用 `init-admin` 生成 admin user，`user_key` 随机 32 位、持久化到
   `./.admin-key`（同一 volume 下每次重启复用）；
2. 立即跑一次 `POST /v3/meta/auth/verify` 校验这把 key，通过后打印一段可直接
   `export`+`claude` 的运行命令，形如：

    ```bash
    export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
    export ANTHROPIC_AUTH_TOKEN='sk-mem-<随机32位>'
    claude --model <PROXY_UPSTREAM_MODEL 里配的模型>
    ```

三个服务默认端口：

| 服务 | 端口 | 用途 |
|---|---|---|
| Memory Core | `8420` | 记忆读写、鉴权、skill/RAG 数据面 |
| Panel UI    | `8125` | 团队记忆管理面板 |
| Knowledge   | `8424` | Wiki / Code-Graph 服务 |
| Proxy       | `8096` | LLM 请求代理（Anthropic / OpenAI 双协议） |

---

## 部署完成后：把它跑起来

服务起来只是第一步。要让 Claude Code 之类的 coding agent 用上团队记忆，
你还需要在面板里**建组织结构**、然后**在 CC 会话里选它们**。

### 第 1 步：登录管理面板

打开浏览器访问 **<http://localhost:8125>**（Panel UI）。

- 第一次访问会看到登录页，用 `start-all.sh` 结尾打印的 admin `user_key`
  （即 `deploy/global-images/.admin-key` 文件里那串 `sk-mem-...`）登录
- admin 登录后能**创建 Team 和子用户**，但目前**不能直接创建 Agent / Wiki
  / Skill 等业务资产**（业务侧 API 会做 `owner_user_id === caller` 校验，
  system_admin 目前不在允许列表里；这层增强会在后续版本放开）
- **正确姿势**：admin 建一把 `normal` 用户 → 复制新用户的 `user_key` →
  退出 admin 换新用户登录 → 后续所有 Team/Agent/Task 都由这个用户 own

> 换句话说：admin 是"运维口"用来管人，业务用户是"应用口"用来管资产。
> 单机本地体验也应遵循这个分层，不要用 admin key 直接跑 CC。

Knowledge Service Swagger（可选，看接口调试用）：
<http://localhost:8424/docs>

### 第 1.5 步：admin 建业务用户（首次必做）

面板左上角「用户管理」（或用 admin 直接调 API）新建一个用户：

```bash
# API 方式，更明确（面板里等价操作在「用户」→「新建」）
ADMIN_KEY=$(cat ./.admin-key)
curl -sS -X POST http://localhost:8420/v3/meta/user/create \
  -H "x-tdai-user-key: $ADMIN_KEY" \
  -H "x-tdai-service-id: default" \
  -H "Content-Type: application/json" \
  -d '{"username":"you"}' | jq
```

返回体里 `data.default_user_key`（`sk-mem-...`）就是新用户的登录 key，
**保存好**（面板无处再看到全值，只有创建时返回一次）。

之后**面板退出登录**，用这把新 key 重新登录 —— 你现在是 `normal` 用户，
可以在自己名下建 Team / Agent / Task 了。

### 第 2 步：在面板里建 Team / Agent / Task

Coding agent 用记忆必须落到具体 `team / agent / task` 三元组上：

1. **Team**（团队）：面板左侧「团队」→ 新建
   - 一个 Team 是一组资产的归属容器（memory、skill、knowledge 都归 Team）
2. **Agent**（智能体）：进入 Team → 「Agent」→ 新建
   - 给它填一段清晰的 `description` + `system prompt`（就是这个 agent 的角色说明）
   - 例：`bug-fix 工程师`、`前端评审 agent`、`SQL 优化师`
3. **Task**（任务，可选）：Team → 「任务」→ 新建
   - Task 是**这一次工作的抓手**，比如「修复登录页 XSS」「上线 v1.4 灰度」
   - 记忆会关联到 Task；不建 Task 也能用，但 L2/L3 会缺 Task 维度

先建**至少 1 个 Team + 1 个 Agent**，可选建 Task。

### 第 3 步：用 Claude Code 走 Proxy

跑 CC 时用**业务用户**的 `user_key`（不是 admin key —— admin 目前无法拥有资产，
proxy 侧 sessionInit 也会因为拉不到 team 列表而选不出东西）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<第 1.5 步建的业务用户的 sk-mem-...>"
claude --model <PROXY_UPSTREAM_MODEL 里配的上游模型>
```

- `ANTHROPIC_BASE_URL` 把 CC 的 API 从 anthropic.com 改指到本机 proxy；
  路径里的 `default` 是 memory 实例 ID（`x-tdai-service-id`），我们的
  本地部署固定叫 `default`
- `ANTHROPIC_AUTH_TOKEN` 是**业务用户**的 user_key（就是第 1.5 步创建
  用户时返回的 `default_user_key`）；proxy 会用它去 core 反查 user_id，
  只有这个 user own 的 team/agent/task 才会出现在下一步表单里
- `--model` 用你在 `.env` 里 `PROXY_UPSTREAM_MODEL` 配的那个上游模型名
  （proxy 会把请求转发到 `PROXY_UPSTREAM_URL`）

### 第 4 步：CC 首次会话，选 Team → Agent → Task

**每开一个新的 CC 会话**，proxy 会用 CC 自带的 `AskUserQuestion` 工具
弹出 3 个连续选择：

```
┌─────────────────────────────────────────────────┐
│  1. 请选择本次会话所属的 Team：                    │
│     ○ Team A                                    │
│     ○ Team B                                    │
│                                                 │
│  2. 请选择「Team A」下要使用的 Agent：              │
│     ○ bug-fix 工程师                             │
│     ○ 前端评审 agent                             │
│                                                 │
│  3. 请选择「Team A」下要关联的任务（可选）：         │
│     ○ 修复登录页 XSS                             │
│     ○ [跳过任务关联]                             │
└─────────────────────────────────────────────────┘
```

**每个问题直接在 CC 里用箭头选、回车确认**。选完之后：

- proxy 记住这次会话的 team/agent/task 绑定
- **后续每一轮请求，proxy 会自动把这个 agent 的 L2/L3 记忆、skill、
  knowledge 注入到 system prompt**
- L0（原始对话）会自动落到 memory-core 的 SQLite 里
- 满足触发条件时后台跑 L1（抽 memory）→ L2（scene）→ L3（persona）

只有**新 CC 会话**才会弹表单；同一次 `claude` 进程内的多轮不会再问。

### 第 5 步：观察记忆一层层长出来

聊完一段之后，在面板里看：

- **左侧「记忆」→ Chat Memory**：能看到 L0 原始对话被切分成的 scene
- **「Agent」详情页 → Profile**：agent 的 L2 scene 与 L3 persona 会逐步累积
- **「Skill」列表**：如果对话里 LLM 判定"这是一条可复用的操作方法"，
  会自动抽出 skill 存下来

用 memory-core `/health` 也能看后台 pipeline worker 有没有干活：

```bash
curl -s http://localhost:8420/health | jq .services.pipelineWorker
```

期望看到 `tasksConsumed` / `tasksCompleted` 数字随着对话增长。

### 常见问题

**Q: CC 会话没有弹选择表单？**
可能 proxy 里 `PROXY_ENABLE_SESSION_INIT=1` 没开。`start-all.sh` 默认
`PROXY_FULL_STACK=1` 已经打开；如果你手动改过 `.env` 或用 `PROXY_FULL_STACK=0`
起的，重启 proxy：`PROXY_FULL_STACK=1 ./start-proxy.sh`。

**Q: 表单选择项里空空的，或者只有别人的 team？**
你可能用 admin key 直接跑 CC 了 —— admin **不能拥有业务资产**（当前限制），
所以列表为空。正确做法：先按第 1.5 步建一个业务用户，用它的 `default_user_key`
作为 `ANTHROPIC_AUTH_TOKEN`。同时那个用户名下必须先在面板里建过 Team/Agent。


**Q: 面板显示"Panel API 8125 未启动"？**
`docker ps` 检查 `tdai-memory-hub` 是不是 healthy；不 healthy 看
`docker logs tdai-memory-hub` 找报错（大概率是 `REMOTE_INSTANCE_URL` /
`LLM_BASE_URL` 之类配错）。

**Q: L1/L2 一直没跑起来，records/ 目录里没东西？**
默认 `promptMode=chat`，对普通对话能抽出 memory；如果你配了
`code` 而对话都是闲聊，LLM 会认为没有可沉淀的东西，返回 0。改回 `chat`
或跟 agent 做**真实工作对话**（改文件、跑测试、给出结论）。

**Q: 想切换到别的 team/agent？**
起一个新的 `claude` 会话（新窗口 / 新 session）就会重新弹选择表单。

---

## 只装 Memory Hub

已有 Memory Core 运行在本机 `8420` 端口时，一条命令拉取 Memory Hub，打开团队记忆面板：

```bash
docker pull docker.io/agentmemory/memory-hub:latest
```

启动 Panel + Knowledge Service：

```bash
docker run -d --name tdai-memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p 8125:8125 -p 8424:8424 \
  -v tdai-panel-data:/data/knowledge \
  -e REMOTE_INSTANCE_URL=http://host.docker.internal:8420 \
  -e REMOTE_INSTANCE_KEY=local \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_BASE_URL=<OPENAI_COMPATIBLE_BASE_URL> \
  -e LLM_API_KEY=<YOUR_API_KEY> \
  -e LLM_MODEL=<MODEL_ID> \
  docker.io/agentmemory/memory-hub:latest
```

打开 [http://localhost:8125](http://localhost:8125)。

## 通过 Proxy 使用 Claude Code

`start-all.sh` 已经把 admin user_key 写在 `deploy/global-images/.admin-key`；
让 Claude Code 直接走 proxy：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="$(cat ./.admin-key)"
claude --model <PROXY_UPSTREAM_MODEL 里配的上游模型>
```

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task
表单）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→
转发到上游 LLM。

关掉完整流水线（只做透传）：`PROXY_FULL_STACK=0 ./start-proxy.sh`。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume 数据 & admin key
./stop-all.sh --purge    # 连 volume、admin key、proxy config 一起清
```

## 更多

其它安装形态（OpenClaw、Hermes、SDK、源码启动、K8s、平台说明），参见
[`deploy/global-images/README.md`](./deploy/global-images/README.md) 与
[`MemoryCore/README_CN.md`](./MemoryCore/README_CN.md)。
