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
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | 需 header 预选 + allowPrivateNetwork |

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
- 4xx → proxy 可达（可能是 session-init 返回的 form 或 auth 问题），**展示响应体给用户参考**，继续
- 5xx → proxy 有问题，**展示完整错误响应**，询问用户是否继续

### Step 6: Header 预选（仅 Hermes / OpenClaw）

如果选的是 hermes 或 openclaw，需要额外收集 header 预选信息。这些 agent 不支持交互式 form，必须在配置中预填 team/agent/task ID。

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

如果面板不可达或用户不想提供，让用户手动填写 team_id / agent_id / task_id。

另外还需要一个 **x-conversation-id**（可自动生成一个如 `conv-20260820-xxxx`）。

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

如果是 Hermes/OpenClaw，追加：
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**检查脚本退出码**：0 = 成功，非 0 = 失败（展示输出给用户）。

### Step 9: 验证写入结果

写入后读取配置文件确认内容正确：
```bash
cat <config_path>
```

展示关键字段给用户确认。

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
2. **4xx 响应**：proxy 可达但业务错误，展示完整响应体，帮用户判断是 key 错误、模型不支持还是其他问题
3. **文件权限**：写入前检查目录是否存在/可写，dsh 需要 chmod
4. **不要猜测**：如果信息不足或状态不明，询问用户而不是假设

## 注意事项

- 一次只配一个 agent，配完后告诉用户可以再运行配置其他 agent
- 脚本会自动备份原配置文件为 `.bak.<timestamp>`
- CC 的所有模型环境变量（HAIKU/SONNET/OPUS/SUBAGENT）都会统一设置为用户选的模型
- Codex 首次对话前必须切 Plan 模式（Shift+Tab），这是客户端限制
- dsh 的 URL 不带 `/v1`，这是客户端硬编码的
- Hermes/OpenClaw 的 x-conversation-id 每次新对话需要手动更换
