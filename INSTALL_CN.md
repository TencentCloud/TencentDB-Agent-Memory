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

# 2) 一键起（交互式）
./start-all.sh
```

`start-all.sh` 是**交互式**的，运行时会自动完成：

1. `.env` 不存在时，自动从 `.env.example` 复制一份
2. 引导你填写两组 LLM（回车 = 保留默认值）：
   - `memory 组`：`MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL`（memory + hub 内部用）
   - `proxy 组`：`PROXY_UPSTREAM_URL` / `PROXY_UPSTREAM_API_KEY` / `PROXY_UPSTREAM_MODEL`（proxy 转发上游，可复用 memory 组）
3. 填完**立即检查 LLM 通路**，不通会提示重新输入，直到通过或主动放弃
4. 把填写值写回 `.env` 持久化
5. 通过后拉起三件套

> 干跑校验（可选，只检查不启动）：`./verify.sh`（`--skip-llm` 跳过 LLM 检查）。

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

服务起来只是第一步。要让 coding agent 用上团队记忆，
你还需要在面板里**建组织结构**、然后**在 agent 会话里选它们**。

---

> **⚠️ 本节以 Claude Code 为示例。** 如果你使用的是其他 agent，请直接跳转到对应文档：
>
> | Agent | 文档 |
> |-------|------|
> | CodeBuddy | [`agents/codebuddy/`](./agents/codebuddy/) |
> | WorkBuddy | [`agents/workbuddy/`](./agents/workbuddy/) |
> | Codex | [`agents/codex/`](./agents/codex/) |
> | DeepSeek Harness | [`agents/dsh/`](./agents/dsh/) |
> | OpenCode | [`agents/opencode/`](./agents/opencode/) |
> | Hermes / OpenClaw / 其他 | [`agents/README.md`](./agents/README.md) |

---

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

### 第 3 步：把 Claude Code 指向 Proxy

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

## 通过 Proxy 接入各类 Agent

Proxy 目前支持 8 类 AI Agent 客户端。每个 agent 的**完整接入配置、适配细节、常见问题**
已拆分到独立文档，按需查阅：

| Agent | 配置方式 | 详细文档 |
|-------|----------|----------|
| **Claude Code** | 环境变量 或 `~/.claude/settings.json` | [`agents/claude-code/`](./agents/claude-code/) |
| **CodeBuddy** | `~/.codebuddy/models.json` | [`agents/codebuddy/`](./agents/codebuddy/) |
| **WorkBuddy** | `~/.workbuddy/models.json` | [`agents/workbuddy/`](./agents/workbuddy/) |
| **Codex** | `~/.codex/config.toml`（⚠️ 首次需切 Plan 模式） | [`agents/codex/`](./agents/codex/) |
| **DeepSeek Harness (dsh)** | `~/.dsh/settings.yaml` + `.credentials.yaml` | [`agents/dsh/`](./agents/dsh/) |
| **OpenCode** | `~/.config/opencode/opencode.json` | [`agents/opencode/`](./agents/opencode/) |
| **Hermes** | `~/.hermes/config.yaml` + Header 预选 | [`agents/hermes/`](./agents/hermes/) |
| **OpenClaw** | `~/.openclaw/openclaw.json` + Header 预选 | [`agents/openclaw/`](./agents/openclaw/) |
| **其他平台** | Header 预选（通用） | [`agents/README.md`](./agents/README.md) |

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task
表单）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→
转发到上游 LLM。

关掉完整流水线（只做透传）：`PROXY_FULL_STACK=0 ./start-proxy.sh`。

## 可选能力：`sessionInit.defaultTaskId`（"本次不关联任务"选项）

**做什么用。** 默认情况下,session-init 表单里 Task 一步只列出该用户在面板
里真实创建过的 Task。如果用户还没建过 Task,或者他这轮就是不想把会话绑到
任何 Task 上——表单要么走不下去,要么直接 bypass。配 `sessionInit.defaultTaskId`
可以解决这问题:proxy 会在**每个 team 的 Task 列表最前面**插一条虚拟条目,
label 固定为 `本次不关联任务`。用户选中它,proxy 就用你配置的这个兜底
`task_id` 完成登记,整个流程正常收尾,但不真的挂载到任何 Task 上。

**什么时候开。** 建议在下列场景配上:

- 有 Agent 但还没建 Task,想让 CC / CodeBuddy 用户首次会话选完不卡住;
- 想在每次会话都给用户一个"一键跳过 Task 绑定"的按钮,免得他们手打或
  翻箭头去绕开;
- 用 L2/L3 记忆 + skill,但整体不需要 Task 维度(整套记忆模型里 Task
  本来就是可选的,见前文第 2 步)。

**行为细节。**

- 虚拟条目始终排在每个 team 的 Task 列表**最前面**,真 Task 跟在它后面。
- 选中它 → session 绑到 `task_id = <你的 defaultTaskId>`。这个 ID **不
  需要**在控制面里真实存在——proxy 对它跳过 `getTask` 调用,`taskDetail`
  为 null → 系统提示词里不注入 `[Task]` 块。`team / agent` 绑定完全正常,
  记忆 / skill / 知识注入不受任何影响。
- 不配置 → 表单只显示真 Task(维持老行为)。在这个能力上线之前,标准
  表单路径根本产不出"没绑 Task"的会话——所以别期望不配也有跳过入口。

### 配置

在 proxy `config.yaml` 已有的 `sessionInit` 段里追加 `defaultTaskId` 一行
即可(`start-proxy.sh` 生成的模板里 `sessionInit` 段已经在了):

```yaml
sessionInit:
  enabled: true
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  defaultTaskId: "no-task"     # 任意稳定字符串,不需要内核里真实存在
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"
```

值随便挑,`no-task` / `default` / 自己的 UUID 都行,只要短且稳定。这个值
会跟着 session-init 请求写到日志 / 埋点里,后续追 trace 时能看到它标记
着"这条会话主动跳过了 Task 绑定"。

> 💡 覆写提醒(同 `/analyse` marker):走 `deploy/global-images/start-proxy.sh`
> 的话,生成的 `config.yaml` 每次启动都会被覆盖——要么改脚本里 YAML 模板
> 加上 `defaultTaskId`,要么用 `PROXY_CONFIG_DIR` 指到你自己维护的
> `config.yaml` 目录。

## 可选能力：`/analyse` URL marker（资产注入效果评估）

**做什么用。** Proxy 内置了一个用于**内部效果评估**的能力,叫**资产反思**
(asset reflection)。开启后,只要请求 URL 里带 `/analyse/` 段,proxy 就会
在系统提示词**末尾**追加一个 `<asset_reflection>` 块,指导 LLM 在最终回答
末尾按固定格式做一次简短复盘——**只对本轮真的调用过的云端资产工具**
(`<skill_tools>` / `<tdai_memory_tools>` / `<knowledge_tools>`)逐个说明:
是否起到作用(拿到了什么关键信息 / 帮它少走了什么弯路 / 或为什么没命中)。
没调过的工具一律不列;本轮完全没调任何工具,仍要输出固定的一行
`【资产反思】本轮未使用任何云端资产工具。`

它的定位是**接入效果验证**——把评测集 / 一次性 curl / 某个 Team 的 staging
CC 会话导到 `/analyse` URL 上,直接读回 LLM 自己给出的逐工具评价,用来判断
skill / 记忆 / 知识注入是否物有所值。**特意做成可选,不建议对线上真实流量
默认打开。**

### 路径写法

把 `/analyse` 作为一段插到 `/{agent}/{spaceId}` 和协议尾巴之间,结构和
`/cost-guard` 完全对称:

```text
# Claude Code(Anthropic Messages)
http://<proxy-host>:<port>/claude-code/<spaceId>/analyse/v1/messages

# CodeBuddy(OpenAI Chat Completions)
http://<proxy-host>:<port>/codebuddy/<spaceId>/analyse/v1/chat/completions

# Codex(OpenAI Responses)
http://<proxy-host>:<port>/codex/<spaceId>/analyse/v1/responses
http://<proxy-host>:<port>/codex/<spaceId>/analyse/responses   # base_url 不带 /v1

# OpenCode(OpenAI Chat Completions,协议同 CodeBuddy)
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/v1/chat/completions
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/chat/completions   # base_url 不带 /v1
```

不带 `/analyse` 的普通请求一字节不改——injector 不 emit 任何块,上游 KV
cache 的前缀完全和平常一致。

### 开启方式(双闸门)

**闸门 1 —— 配置开关。** `injection.assetReflection.markerOptIn` **默认已开
(true)**——`start-proxy.sh` 生成的模板 / `config.example.yaml` 都写着 true,
直接把这个开关删掉也会走默认 true。想显式关掉时才在 proxy `config.yaml` 的
`injection` 段追加:

```yaml
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory
  assetReflection:
    markerOptIn: false      # 默认 true;这里显式关掉才不允许 /analyse marker
```

`markerOptIn` 显式为 `false` 时,任何带 `/analyse/` 段的请求都直接
`404 analyse_marker_disabled` 拒绝——用来给"确定不需要资产反思能力"的部署
兜底,避免客户端"以为"打开了 marker 实际却 fall through 到默认透传。

**闸门 2 —— URL 段。** 即便 `markerOptIn: true`,也只有 URL 真的带
`/analyse/` 段时,反思块才会被追加。普通的
`/claude-code/<spaceId>/v1/messages` 完全走原路,和以前一模一样。

### 有效 tag 列表

反思块里列出的 tag 名,由本节点上实际启用的资产 injector 决定
(`skill` / `tdai-memory` / `knowledge`)。一个都没启用时,反思块内容为空
(injector 早退)——所以这个 marker 只有在至少一个资产 injector 挂上
pipeline 时才有意义。

> 💡 如果你走的是 `deploy/global-images/` 的 `start-proxy.sh`,那份
> `config.yaml` 每次启动都会被脚本覆写。要么改 `start-proxy.sh` 里的
> YAML 模板加上 `assetReflection` 段,要么用 `PROXY_CONFIG_DIR` 指向你
> 自己维护的 `config.yaml` 目录,绕开自动生成。

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

其它安装形态（OpenClaw、Hermes、CodeBuddy、WorkBuddy、SDK、源码启动、K8s、平台说明），参见
[`deploy/global-images/README.md`](./deploy/global-images/README.md) 与
[`MemoryCore/README_CN.md`](./MemoryCore/README_CN.md)。
