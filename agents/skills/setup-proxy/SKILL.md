---
name: setup-proxy
description: 交互式引导用户配置 AI Agent 接入 Memory Proxy（逐步探测、逐步验证）
triggers:
  - 配置 proxy
  - 配置 agent
  - setup proxy
  - 接入 proxy
  - 接入记忆
---

# Setup Proxy — Agent 接入配置向导

你正在帮助用户将一个 AI Agent 客户端（Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / Hermes / OpenClaw）接入 Memory Proxy。

## 背景知识

Memory Proxy 是一个 LLM 请求代理，在请求转发到上游 LLM 之前注入团队记忆/技能/知识。每个 agent 客户端有不同的配置文件格式和协议：

| Agent | 配置文件 | 协议 | 特殊要求 |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | env 字段里写 5 个模型变量 |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | models 数组追加条目 |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML 格式，必须 `wire_api = "responses"` |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | 顶层数组 |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (无 /v1) | 两个文件 + chmod 700/600 |
| hermes | `~/.hermes/config.yaml` | OpenAI Chat | 需 header 预选 (x-team-id/agent-id/task-id) |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | 推荐 Session Bridge + Web Init；兼容静态 header |

## 脚本位置

配置写入脚本：`agents/skills/setup-proxy/setup-proxy.sh`（相对于仓库根目录）

## 执行流程

**严格按以下顺序，每一步必须验证通过后再进入下一步。**

### Step 1: 扫描现有配置

先检查用户是否已有 proxy 配置，避免重复填写：

```bash
# 检查 Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# 检查 CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# 检查其他 agent 类似...
```

如果扫描到含 proxy 路径的 URL（包含 `/claude-code/`、`/codebuddy/`、`/codex/` 等片段），**提取并展示**：
- Proxy 地址（URL 中 `/<agent>/` 之前的部分）
- Instance ID（URL 中 `/<agent>/` 之后的那段）
- User Key（对应字段的值，脱敏显示首尾 4 字符）
- Model ID

询问用户："检测到现有配置，是否复用？"
- 是 → 跳到 Step 3
- 否 → 继续 Step 2 手动输入

### Step 2: 收集基础信息

依次向用户获取：
1. **Proxy 地址**（含协议+端口，如 `http://127.0.0.1:8096`）
2. **Instance ID**（默认 `default`，本地部署一般不用改）
3. **User Key**（从面板 API Key 页获取，不限格式）

每个信息获取后确认，不要一次问三个。

### Step 3: 选择 Agent

展示 7 个可选 agent 让用户选择**一个**：
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. Hermes
7. OpenClaw

### Step 4: 填写模型 ID

告诉用户：
- 这个模型 ID 必须是 Proxy 上游支持的模型
- 给出常见例子：`claude-sonnet-4-20250514`、`claude-opus-4.7`、`gpt-5.5`、`deepseek-r1`

### Step 5: 健康探测（关键验证步骤）

先获取候选 Proxy 基础地址，从 **Agent 实际执行主动工具的环境**验证：

```bash
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "${PROXY_HOST}/health"
```

确认健康响应来自预期的 MemoryProxy，验证通过后，该地址才是
`injection.externalGatewayUrl` 的候选。部署机、浏览器与 Agent 工具可能不在同一
网络环境；不要自动选 Docker 容器 IP，也不要从 Host / X-Forwarded-Host 推导。
若 Agent 同时管理本地 Proxy 部署，可以协助把已验证值写入部署目录 `.env` 的
`PROXY_EXTERNAL_GATEWAY_URL`，保留原有能力开关后重启 Proxy；若服务在其他机器且
无管理权限，只提示部署管理员配置，不修改远端环境。该变量独立于 Panel 展示用的
`MEMORY_HUB_PROXY_PUBLIC_URL`。健康检查不替代下方模型协议验证和初始化后的主动查询。

**根据选中 agent 的协议**，构造对应的 curl 探测请求：

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / Hermes / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat 但不带 /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (更通用)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**判断结果**：
- HTTP 连接失败 (000) → 告诉用户 proxy 不可达，让用户检查地址/端口/服务状态，**不要继续**
- 2xx → 完全正常，继续
- 4xx → 网络可达但业务验证未通过，先排查鉴权或参数，只展示脱敏摘要
- 5xx → 业务验证未通过，只展示状态码和脱敏摘要，修复后重试

### Step 6: 会话初始化方式

OpenClaw 推荐按 `agents/openclaw/README.md` 安装和授权 Session Bridge（最低已验证
版本 2026.8.2），使用 Web Init 选择 Team/Agent，Task 可选。不生成静态 conversation ID，
不替用户自动安装或授权插件。完成连接后让用户在原会话重发请求。

Hermes 保留静态 header 预选。OpenClaw 仅在用户明确选择兼容/高级路径时收集
Team/Agent 和可选 Task；旧静态会话模式仍需要自行管理 conversation ID。

**优先方案：通过面板 API 拉取列表让用户选择**

询问用户是否提供面板后端地址（默认 `http://127.0.0.1:8125`）。如果提供了：

```bash
# 1. 先通过 auth/verify 拿 user_id
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# 从 .data.user.user_id 提取

# 2. 拉 Team 列表
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# 从 .data.items 展示让用户选

# 3. 拉 Agent 列表（带 owner_user_id 过滤）
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# 从 .data.items 展示让用户选

# 4. 拉 Task 列表
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# 第一个选项始终是"本次不关联任务 (no-task)"
```

如果面板不可达或用户不想提供，让用户手动填写 team_id / agent_id，task_id 可省略。

仅无 Bridge 的静态兼容模式需要 **x-conversation-id**（如 `conv-20260820-xxxx`）。

### Step 7: 确认配置文件路径

告诉用户默认路径（见上方表格），询问是否使用默认路径。如果不是让用户填。

### Step 8: 调用脚本写入配置

所有信息收集完毕且验证通过后，**调用脚本的非交互模式**写入配置：

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

如果是 Hermes 或明确选择 OpenClaw 静态兼容模式，追加（Task 可省略）：
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

OpenClaw 默认不传 `--conv-id` 或资产 header；脚本生成 `/openclaw/<instance>/v1`
provider 路径。显式 `--conv-id` 保留旧静态模式，也可用 `--openclaw-static-headers`。
Bridge 搭配高级静态 Team/Agent 预选时，可传 `--team-id` / `--agent-id`，不传 `--conv-id`。

**检查脚本退出码**：0 = 成功，非 0 = 失败（展示输出给用户）。

### Step 9: 验证写入结果

写入后只提取非敏感字段确认路径、provider、模型和 header 名称；不要 `cat` 完整
私有配置，不展示 user key、Authorization 或有效 token。

### Step 9.5: 提醒用户切换模型

**配置写入不等于生效**，必须提醒用户在客户端中切换到 Proxy 模型才会走 Proxy 链路：

| Agent | 如何切换 |
|-------|----------|
| Claude Code | 无需操作，`settings.json` 的 env 启动时自动加载 |
| CodeBuddy | 对话框中切换模型为 **proxy-memory-agent**（即配置的模型 ID） |
| Codex | 无需操作，`config.toml` 已指定 model |
| WorkBuddy | 模型选择器中切换到自定义模型列表里的对应模型 |
| dsh | 无需操作，`settings.yaml` 已指定模型 |
| Hermes / OpenClaw | 确保客户端选择的 provider/模型指向 Proxy 配置 |

**务必告知用户**：如果不切换模型，请求不会经过 Proxy，记忆/技能注入不会生效。

### Step 10: 资产导入（可选）

配置完成后询问用户：是否要导入该 Agent 的本地资产（skill + 对话历史）到团队记忆？

如果用户选择导入：
- 需要 Panel URL、Team ID、Agent ID
- 如果之前 Step 6 已经选过 team/agent，推荐复用
- 否则让用户提供

然后调用：
```bash
PANEL_URL="${PANEL_URL}" TDAI_SERVICE_ID="${INSTANCE_ID}" TDAI_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

如果 `tsx` 不可用，提示用户手动运行命令。

## 错误处理原则

1. **连接失败**：明确告诉用户哪一步失败了，给出排查建议（检查服务状态、端口、网络）
2. **4xx 响应**：proxy 可达但业务错误，用状态码和脱敏摘要排查 key 或模型问题
3. **文件权限**：写入前检查目录是否存在/可写，dsh 需要 chmod
4. **不要猜测**：如果信息不足或状态不明，询问用户而不是假设

## 注意事项

- 一次只配一个 agent，配完后告诉用户可以再运行配置其他 agent
- 脚本会自动备份原配置文件为 `.bak.<timestamp>`
- CC 的所有模型环境变量（HAIKU/SONNET/OPUS/SUBAGENT）都会统一设置为用户选的模型
- Codex 首次对话前必须切 Plan 模式（Shift+Tab），这是客户端限制
- dsh 的 URL 不带 `/v1`，这是客户端硬编码的
- Hermes 及未使用 Bridge 的 OpenClaw 静态模式，每次新对话需手动更换 x-conversation-id
- OpenClaw Bridge 动态管理原生会话身份；切换绑定请创建新会话，不使用 mem:session-reset
