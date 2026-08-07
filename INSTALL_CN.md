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
- admin 登录后可以直接使用 Wiki、CodeGraph、Skill 等资产管理功能，创建 Team / Agent / Task 等业务资产
- 如果希望隔离运维与业务（推荐），可创建 `normal` 业务用户 → 复制新用户的 `user_key` → 退出 admin 换新用户登录

> 换句话说：admin 是"运维口"用来管人，业务用户是"应用口"用来管资产。
> 单机本地体验也推荐遵循这个分层，不要用 admin key 直接跑 CC。
> 注：2.0.0-beta.1 中 admin 不能拥有业务资产；2.0.0 正式版起 admin 也可以直接操作资产。

Knowledge Service Swagger（可选，看接口调试用）：
<http://localhost:8424/docs>

### 第 1.5 步：admin 建业务用户（可选，推荐隔离运维与业务）

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
可以在自己名下建 Team / Agent / Task 了。当然，admin 也可以直接操作，这里只是推荐隔离。

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

跑 CC 时用 admin 或业务用户的 `user_key`（2.0.0 正式版起 admin 也可拥有资产）：

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

> 💡 **也可以用 CodeBuddy 走 Proxy**——配置方式见下方
> [通过 Proxy 使用 CodeBuddy](#通过-proxy-使用-codebuddy) 章节。

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
请确认当前使用的账号已在面板中创建过 Team 和 Agent。如果用的是 admin 账号，确保已创建了相关资产；如果用的是业务用户账号，检查是否已在对应 team 下建过 Agent。


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

## 通过 Proxy 使用 CodeBuddy

[CodeBuddy](https://www.codebuddy.ai/) 是腾讯推出的 AI 编程助手 IDE 插件。通过自定义模型配置，你可以把 CodeBuddy 的对话请求路由到 Proxy，在 IDE 内获得与 Claude Code 相同的记忆能力。

### ⚠️ 已知的会话初始化限制

CodeBuddy **4.10.2、4.10.3、4.10.4** 存在已知 Bug：这些版本不会在请求中
携带 `sessionId` / 会话头，导致 Proxy 无法完成 Session 初始化。Proxy 通过
[`SessionStart` hook](https://www.codebuddy.ai/docs/zh/ide/User-guide/Hooks) 兜底：
将会话 ID 注入到 prompt 中，Proxy 端提取后作为回退（见下方
[「为有问题的 CodeBuddy 版本修复会话 ID」](#为有问题的-codebuddy-版本修复会话-id)）。
若这些版本未配置 hook，会话初始化将失败。

### 配置

在开发机的 `~/.codebuddy/models.json` 文件中写入以下内容（注意替换 API Key）：

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<业务用户的 sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

- `id`：Proxy 上游 LLM 支持的模型 ID（必须与 Proxy 配置的 `PROXY_UPSTREAM_MODEL`
  或 upstream 模型列表中的某个模型匹配，如 `claude-sonnet-4-20250514`）
- `name`：在 CodeBuddy 对话框中显示的名称，可自定义（如 `proxy-memory-agent`）
- `vendor`：模型供应商标识，仅用于 UI 展示（如 `claude`、`openai`），不影响实际请求
- `apiKey`：使用**业务用户**的 `user_key`（与 Claude Code 的
  `ANTHROPIC_AUTH_TOKEN` 相同；不建议直接使用 admin key）
- `url`：Proxy 地址 + `/codebuddy/default` 路径（端口与 Claude Code 一致，
  默认 `8096`）；`default` 是 memory 实例 ID

配置完成后，在 CodeBuddy 对话框中选择刚才配置的模型名称即可开始对话。
Session init 流程与 Claude Code 一致（选 Team → Agent → Task）。

#### 可选：为有问题的 CodeBuddy 版本修复会话 ID

针对 **4.10.2 ~ 4.10.4**（这些版本不携带会话头），启用项目自带的
`SessionStart` hook，将会话 ID 注入到 prompt，供 Proxy 端兜底提取。
将 hook 指向 `deploy/global-images/hooks/session_start.py`（绝对路径）：

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /绝对路径/deploy/global-images/hooks/session_start.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

将该配置放到开发机 CodeBuddy 的**项目级配置**（或 `settings.json`）中。
hook 仅注入会话 ID，不会阻断启动；已能正常携带会话头的版本（≥ 4.10.5 或
≤ 4.10.1）不受影响。

## 通过 Proxy 使用 Hermes

[Hermes](https://hermes-agent.nousresearch.com/docs/) 是一个开源的 AI Agent 框架。通过配置 extra headers，可以让 Hermes 的对话请求经过 Proxy，获得团队记忆能力。

### 配置

编辑 `~/.hermes/config.yaml`：

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:<port>/hermes/<spaceId>
  api_key: <从面板获取的 API Key>
  extra_headers:
    x-team-id: <从面板获取的 team_id>
    x-agent-id: <从面板获取的 agent_id>
    x-task-id: <从面板获取的 task_id>
    x-conversation-id: <自定义的会话标识>
```

- `base_url`：Proxy 地址 + `/hermes/<spaceId>` 路径。`<spaceId>` 是 memory 实例 ID（从面板获取，通常为 `default`）
- `api_key`：业务用户的 `user_key`（从管理面板"API Key"页获取）
- `x-team-id` / `x-agent-id`：从管理面板对应页面获取，与 CodeBuddy / Claude Code 的获取方式相同
- `x-task-id`：从管理面板"任务管理"页获取。**当前版本必填**——缺少此字段会导致 session 注册失败，记忆功能不生效（见下方[已知限制](#关于-x-task-id-的已知限制)）
- `x-conversation-id`：用户自定义的会话标识（见下方[已知限制](#关于-x-conversation-id-的已知限制)）

## 通过 Proxy 使用 OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) 是一个开源的 AI 编码 Agent。通过自定义 provider 配置，可以让 OpenClaw 的请求经过 Proxy。

### 配置

编辑 `~/.openclaw/openclaw.json`，在 `models.providers` 中添加：

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:<port>/openclaw/<spaceId>",
        "apiKey": "<从面板获取的 API Key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<从面板获取的 team_id>",
          "x-agent-id": "<从面板获取的 agent_id>",
          "x-task-id": "<从面板获取的 task_id>",
          "x-conversation-id": "<自定义的会话标识>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

- `baseUrl`：Proxy 地址 + `/openclaw/<spaceId>` 路径
- `apiKey`：业务用户的 `user_key`
- `headers`：必须包含 `x-team-id`、`x-agent-id`、`x-task-id`、`x-conversation-id`。其中 `x-task-id` 当前版本为必填（见下方[已知限制](#关于-x-task-id-的已知限制)）
- `models[].id`：必须与 Proxy 上游配置的模型 ID 匹配

## 其他平台接入（通用）

除 ClaudeCode / CodeBuddy / Hermes / OpenClaw 外，任何兼容 OpenAI API 的平台或自行开发的 Agent 均可接入 Proxy，获得团队记忆能力。

### 接入方式

将平台的 API base URL 指向 Proxy：

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`：平台标识，必须从 Proxy 支持的以下值中选用：`claude-code`、`codebuddy`、`hermes`、`openclaw`。如果使用的是其他平台，可伪装成其中某一个接入（如使用 `codebuddy` 作为标识）
- `<spaceId>`：memory 实例 ID（本地部署固定为 `default`）

请求 Path 自动拼接 `/v1/chat/completions`（OpenAI 协议）或 `/v1/messages`（Anthropic 协议）。

### 必须携带的 Header

| Header | 说明 |
|--------|------|
| `Authorization: Bearer <user_key>` | 业务用户的 API Key（从面板"API Key"页获取） |
| `x-team-id` | 团队 ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | 任务 ID（当前版本必填，见下方[已知限制](#关于-x-task-id-的已知限制)） |
| `x-conversation-id` | 会话标识，由客户端自行生成和管理 |

以上 header 缺一不可——Proxy 会通过 header 直接完成 session 注册，跳过交互式表单。无法提供 headers 的平台将触发 session bypass，记忆注入和对话回流均不生效。

## 关于 `x-task-id` 的已知限制

> ⚠️ **当前版本限制**：`x-task-id` 在 Hermes / OpenClaw 场景下为**必填项**。
>
> Proxy 的 header 预选机制要求 `x-team-id` + `x-agent-id` + `x-task-id` 三者齐全才能完成 session 直接注册。缺少 `x-task-id` 时，Proxy 会尝试弹出交互式表单让用户选择 task，但 Hermes / OpenClaw 无法响应交互式表单，最终导致 session bypass（记忆注入和对话回流均不生效）。
>
> 这带来的不便：
>
> 1. 用户需要预先在面板上创建 Task 并获取 `task_id`，增加了接入门槛。
> 2. 切换不同任务时需要手动修改配置文件中的 `x-task-id`。
>
> 我们将在下一个版本中支持 `x-task-id` 可选：当 header 中未指定 task 时，Proxy 自动选择该 agent 下的默认 task 或跳过 task 绑定，直接完成 session 注册。

## 关于 `x-conversation-id` 的已知限制

> ⚠️ **当前版本限制**：Hermes 和 OpenClaw 需要在配置文件中静态指定 `x-conversation-id`。
> 这与 Claude Code / CodeBuddy 不同（它们由 SDK 自动管理 session ID）。
>
> 当前限制：
>
> 1. **同一个 conversation ID 的所有请求共享同一个 session** —— 记忆注入、对话回流都绑定到这个 ID。
> 2. **每次开启新对话时需要手动更换 conversation ID**，否则会继续沿用上次的 session 状态。
> 3. **部分客户端的 tool call 后续请求可能不携带 extra headers**，导致那些轮次跳过记忆注入和对话回流。
>
> 我们将在下一个版本中优化 conversation ID 的使用体验。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume 数据 & admin key
./stop-all.sh --purge    # 连 volume、admin key、proxy config 一起清
```

## 更多

其它安装形态（OpenClaw、Hermes、CodeBuddy、SDK、源码启动、K8s、平台说明），参见
[`deploy/global-images/README.md`](./deploy/global-images/README.md) 与
[`MemoryCore/README_CN.md`](./MemoryCore/README_CN.md)。
