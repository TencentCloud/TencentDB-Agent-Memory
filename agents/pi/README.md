# Pi (earendil-works)

> agentSource: `pi` | 协议: OpenAI Chat Completions | Handler: `handler.ts` (与 CB / dsh / opencode 共享)
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

[Pi](https://github.com/earendil-works/pi-coding-agent) is a terminal coding agent with an extension system. Unlike the other agents (which point their base URL at the proxy via a config file), Pi uses a **Pi extension** (`@tencentdb-agent-memory/pi-tdai-client`) that registers a `tdai` provider, injects a per-session `x-conversation-id` header, and renders the interactive Team/Agent/Task picker as a Pi-native TUI menu.

### 方式一：安装扩展 + 环境变量（推荐）

```bash
# Install the extension (one time)
pi install npm:@tencentdb-agent-memory/pi-tdai-client

# Set your user key (from the TDAI panel → API Key page)
export TDAI_USER_KEY="<your-user-key>"

# Run Pi with the tdai provider
pi --provider tdai --model <model-id>
```

On the **first turn of each new session**, if no preset identity is set, the proxy sends a Team → Agent → Task form and the extension renders it as a TUI menu (`↑↓` navigate, `Enter` select, `Esc` cancel). Pick once and the session is bound for its lifetime — the chosen team's memory (L3 persona, L2 scene index) is injected and the conversation is captured (L0).

### 方式二：固定身份（跳过 picker — CI / 脚本 / 固定上下文）

```bash
export TDAI_USER_KEY="<your-user-key>"
export TDAI_TEAM_ID="<team-id>"
export TDAI_AGENT_ID="<agent-id>"
# TDAI_TASK_ID is optional — set only for task-scoped recall
pi --provider tdai --model <model-id>
```

### 方式三：从仓库 checkout 快速加载（开发/测试）

```bash
export TDAI_USER_KEY="<your-user-key>"
pi -e ./MemoryCore/pi-plugin --provider tdai --model <model-id>
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `TDAI_USER_KEY` | yes | — | 业务用户的 user_key（面板 → API Key 页） |
| `TDAI_PROXY_URL` | no | `http://127.0.0.1:8096` | proxy 地址 |
| `TDAI_SPACE_ID` | no | `default` | memory 实例 ID（本地部署固定 `default`） |
| `TDAI_AGENT_SOURCE` | no | `pi` | agent source；设 `codebuddy` 可回退到 CodeBuddy profile 调试 |
| `TDAI_TEAM_ID` | no | — | preset — 设后跳过 picker |
| `TDAI_AGENT_ID` | no | — | preset — 设后跳过 picker |
| `TDAI_TASK_ID` | no | — | preset — 设后缩小 recall 到特定 task |
| `TDAI_MODEL` | no | — | 静态模型 ID（无动态模型目录时的兜底） |

> `TDAI_TEAM_ID` + `TDAI_AGENT_ID` 同时设则跳过交互 picker。`TDAI_TASK_ID` 可选。
> 缺少 `TDAI_USER_KEY` 不会阻塞 Pi 启动 — 扩展只 warn 并跳过注册 `tdai` provider。

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→ 转发到上游 LLM。

客户端发出的请求命中 `POST /pi/:spaceId/v1/chat/completions`。

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-conversation-id` |

Pi 扩展为每个 session 自动生成 `x-conversation-id`（格式 `pi-<uuid>`），无需手动配置。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制

Pi 使用 **TUI 原生菜单** 发起交互式 Form：

- 扩展拦截 proxy 返回的 session-init form，渲染为终端菜单
- 按键：`↑↓` 导航，`Enter` 选择，`Esc` 取消
- 要求交互式模式（默认的 `pi` TUI）；`pi -p` / RPC / 非 TUI 模式无法渲染，需用 preset 环境变量

### 3.2 状态机

```
asset_confirm → team_select → agent_task_select → initialized
```

4 步流程：
1. **asset_confirm** — 是否关联团队资产
2. **team_select** — 选择团队
3. **agent_task_select** — 选择 Agent（+ Task，Task 可跳过）
4. **initialized** — 注入资产，进入正常对话

### 3.3 预选身份（Header Auto-Select）

设 `TDAI_TEAM_ID` + `TDAI_AGENT_ID` 后，proxy 跳过交互表单直接注册（`headerAutoSelect.enabled=true`）。

---

## 4. 模型目录（动态发现）

扩展启动时调用 `GET {TDAI_PROXY_URL}/{TDAI_AGENT_SOURCE}/{TDAI_SPACE_ID}/v1/models`（user-key 鉴权），拉取上游网关模型列表并持久化。静态 `TDAI_MODEL` 是该端点不可达时的兜底。需 proxy 构建含 `handleModelsCatalog`（`GET /:agent/:spaceId/v1/models`）。

---

## 5. 注入

Pi 的 system prompt 使用 `Label:` 行（非 markdown heading，也非 XML tag）。`PiProfile`（`MemoryProxy/src/injection/agents/pi/profile.ts`）按 label 行拆分并映射语义槽位：

| 槽位 | Pi Label / 锚点 | 说明 |
|------|-----------------|------|
| tools | `Available tools` | skill tools 注入在 tools 之前 |
| skills | `Guidelines` | 无独立 skills 段，锚定 Guidelines |
| memory | `system.suffix` | 无 memory 段，注入到末尾 |
| task_context | `<project_context>` | project context XML 块 |

Lossless parse→rebuild（`join "\n"`，无 trim），保证 Pi prompt drift 不破坏注入——只移动锚位。

---

## 6. 验证（集成闸门）

确认 proxy 识别 `pi` agent-source 且记忆已联通：

```bash
TDAI_USER_KEY=<your-user-key> TDAI_TEAM_ID=<...> TDAI_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider tdai --model <model-id> -p "say OK"
# 检查 proxy 日志：
docker logs tdai-proxy --tail 30 2>&1 | grep -E "agentSource|write-l0|register"
```

预期看到 `agentSource=pi`、`register directly`、和 `write-l0` 行。若看到 `agentSource=codebuddy`（或默认值）或无 `write-l0`，说明 base URL 或身份 header 有误。

---

## 7. 故障排查

- **交互模式是默认。** 未设 `TDAI_TEAM_ID`/`TDAI_AGENT_ID`/`TDAI_TASK_ID` 时，新 session 首轮显示 Team → Agent → Task picker（↑↓ + Enter）。需交互式（TUI）模式。
- **使用用户 API key，不是 admin key。** Proxy 校验 `Authorization: Bearer` 对应用户的 API key（面板 → API Key）。admin/gateway key 是内部端点用的。
- **`x-task-id` 可选。** 只需 team + agent 即可有记忆（宽 recall）。设 `TDAI_TASK_ID` 仅缩小 recall 到特定 Task。过期/未知 task id 会被 warn 并丢弃，不阻塞记忆。
- **非交互模式需 preset 环境变量。** `pi -p` / RPC / 非 TUI 模式无法渲染 picker，需设 `TDAI_TEAM_ID`/`TDAI_AGENT_ID` 跳过。
- **缺少必填环境变量不阻塞 Pi。** 若 `TDAI_USER_KEY` 未设，扩展在加载时 warn 并跳过注册 `tdai` provider — Pi 正常启动，只是没有 TDAI provider。设好变量重启 Pi 即可。
- **回退到 CodeBuddy profile 调试。** 设 `TDAI_AGENT_SOURCE=codebuddy` 走已有验证的 CodeBuddy profile（注入仍工作；锚位更粗）。用于隔离问题是 Pi 特有还是 proxy/config 问题。

---

## 8. 扩展源码

Pi 扩展源码在 `MemoryCore/pi-plugin/`。详见 [pi-plugin README](../../MemoryCore/pi-plugin/README.md)。
