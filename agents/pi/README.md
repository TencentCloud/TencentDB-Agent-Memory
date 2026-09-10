# Pi

> agentSource: `pi` | 协议: OpenAI Chat Completions | Handler: `handler.ts` (复用 CB 状态机，经 `session/index.ts` 默认分支)

[Pi](https://github.com/earendil-works/pi-coding-agent) 是 earendil-works 出品的开源
AI 编码 agent。与其他客户端不同，Pi **没有内置的 form 工具**——它通过一个 **Pi 扩展**
(`MemoryCore/pi-plugin`) 把 proxy 的 `ask_followup_question` form 渲染成 Pi 原生的
TUI 选择菜单，从而获得与 Claude Code / CodeBuddy 一致的"新会话首轮选 Team → Agent → Task"
交互体验。

---

## 1. 客户端接入配置

Pi 的接入方式与文件配置型客户端（CB / Codex 等）不同：**没有配置文件**，全部通过
**环境变量 + 扩展自动发现**完成。

### 1.1 安装扩展

把仓库内的 `MemoryCore/pi-plugin` 放到 Pi 的扩展目录（二选一）：

```bash
# 方式 A：软链（推荐，跟随仓库更新）
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/MemoryCore/pi-plugin" ~/.pi/agent/extensions/pi-tdai-client

# 方式 B：复制
cp -r MemoryCore/pi-plugin ~/.pi/agent/extensions/pi-tdai-client
```

Pi 启动时会自动加载 `~/.pi/agent/extensions/` 下的扩展。

### 1.2 环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `TDAI_USER_KEY` | **是** | — | 业务用户的 `user_key`（面板 → API Key），**不是** admin/gateway key |
| `TDAI_PROXY_URL` | 否 | `http://127.0.0.1:8096` | Proxy 地址 |
| `TDAI_SPACE_ID` | 否 | `default` | memory 实例 ID（spaceId） |
| `TDAI_AGENT_SOURCE` | 否 | `pi` | URL 首段；设 `codebuddy` 可回退到 CB profile 调试 |
| `TDAI_MODEL` | 否 | `glm-5.2-vision` | Proxy 上游支持的模型 ID |
| `TDAI_TEAM_ID` | 否 | — | **交互模式不设**；设了则跳过首轮 picker（静态预选） |
| `TDAI_AGENT_ID` | 否 | — | 同上 |
| `TDAI_TASK_ID` | 否 | — | 设了则把 recall 收窄到该 task |

### 1.3 启动

```bash
# 交互模式（默认）：不设 TEAM/AGENT，首轮弹 picker
export TDAI_USER_KEY=<业务用户的 sk-mem-...>
pi --provider tdai --model "${TDAI_MODEL:-glm-5.2-vision}"

# 静态预选（CI / 脚本 / 固定上下文）：设了 TEAM+AGENT 则跳过 picker
TDAI_TEAM_ID=<tid> TDAI_AGENT_ID=<aid> TDAI_USER_KEY=<key> \
  pi --provider tdai --model "${TDAI_MODEL:-glm-5.2-vision}"
```

> 也可用 `pi -e ./MemoryCore/pi-plugin --provider tdai ...` 做一次性加载测试，
> 无需软链。

请求路径：
- 主路径: `POST /pi/:spaceId/v1/chat/completions`
- 扩展通过 `before_provider_headers` 钩子为每条请求注入 `x-conversation-id: pi-<sessionId>`

---

## 2. Session ID

| 优先级 | Header |
|--------|--------|
| 1 | `x-conversation-id`（扩展注入 `pi-<sessionId>`） |
| 2 | `x-session-id` |

Pi 客户端本身不携带 session ID header；`pi-plugin` 在 `before_provider_headers`
事件里用 `ctx.sessionManager.getSessionId()` 生成稳定的 `pi-<sid>` 写入
`x-conversation-id`，proxy 据此识别同一会话。同一 Pi 进程内 sessionId 不变 →
proxy 的 L2b session recovery 在后续轮次复用同一绑定，**picker 只在首轮弹出**。

---

## 3. Session Init（会话初始化 / Form）

### 3.1 机制 —— 交互式 Picker（Pi 的关键差异）

其他客户端（CC / CB / Codex …）**原生**支持 `AskUserQuestion` /
`ask_followup_question` 这类 form 工具，proxy 伪造一个该工具的 `tool_call`，客户端
原生渲染成选择框。**Pi 没有这种内置工具**，所以由 `pi-plugin` 注册一个同名的
**自定义工具** `ask_followup_question`，在其 `execute()` 里用 `ctx.ui.custom` 渲染
Pi 原生的 TUI 菜单（↑↓ 选择 + Enter 确认 + Esc 取消）。

完整链路：

1. **首轮新会话**，proxy 拦截请求（不转发上游），返回一个伪造的 assistant 消息，
   内含 `ask_followup_question` 的 `tool_call`，`function.arguments` 是双重编码的
   JSON：`{"title":"...","questions":"[{\"id\":\"team\",...}]"}`。
2. Pi 的 agent loop 看到该 `tool_call` → 执行 `pi-plugin` 注册的
   `ask_followup_question` 工具 → `parseFormArgs` 解析 → `renderSessionInitPicker`
   逐题渲染 TUI 菜单。
3. 用户选择 → 工具返回 `<question_answer>` XML（`<question_item id="..."><answers>
   EXACT_OPTION_LABEL</answers></question_item>`）。
4. Pi 把工具结果作为 `role:"tool"` 消息（`tool_call_id = call_session_init_<ts>` 原样保留）
   随下一条请求发回 → proxy 的 `getLastUserMessageText` 匹配
   `/call_(wb_|dsh_)?session_init_/` → `parseQuestionAnswerXml` 拆分多题答案 →
   状态机推进。
5. team + agent（+ 可选 task）解析完毕 → proxy 注册 session，把用户**原始 prompt**
   连同该 team 的 L2/L3 记忆一起转发上游。**后续轮次跳过 picker**（绑定是会话级）。

- Tool name: `ask_followup_question`（与 CB 同名 → 复用 CB 的 form builder + extractor）
- Call ID prefix: `call_session_init_`（CB 默认前缀；pi 不走 oc_/wb_/dsh_ 特化分支）
- 协议: OpenAI SSE / non-stream tool_calls
- **零 proxy 改动**：`agentSource=pi` 在 `session/index.ts` 里走默认分支落到
  `cbHandle`，复用 CB 的 `buildFakeFormResponse` + 状态机 + extractor。

### 3.2 状态机

复用 CB 状态机：

```
asset_confirm → team_select → agent_task_select → initialized
```

- `asset_confirm`：首轮先问"是否关联团队资产"（是 / 否）。选"否" → 直接透传，不注入。
- `agent_task_select`：**一个 form 同时带 2 个 question**（agent + task），picker 在一次
  工具执行内连渲两个菜单；XML 的 per-`id` 拆分让 extractor 不会把两个答案搞混。

### 3.3 分页

Pi 路径（CB 默认 form）发送**扁平 option 列表**，无"更多 →"分页。所有 team / agent /
task 选项一次性展示（实测与 Claude Code 的 4 选项分页不同）。

### 3.4 跳过 Session Init

- `asset_confirm` 选"否，本次不关联" → 直接透传
- 任何菜单按 Esc → 工具返回 "User cancelled session init" → proxy 走 bypass
- 设了 `TDAI_TEAM_ID` + `TDAI_AGENT_ID` 环境变量 → 静态预选，proxy `register directly`，
  **picker 根本不弹**（CI / 脚本场景）

### 3.5 非 TUI 模式

`pi -p`（print 模式）或 RPC 模式下 `ctx.mode !== "tui"`，picker 无法渲染。工具返回
提示文本，要求用户改用交互模式，或设置 `TDAI_TEAM_ID`/`TDAI_AGENT_ID` 走静态预选。
不会 hang。

---

## 4. 注入 Profile

Pi 有自己的注入 profile `PiProfile`（`MemoryProxy/src/injection/agents/pi/`）。
Pi 的 system prompt 用 `Label:` 行（如 `Available tools:`、`Guidelines:`、
`Pi documentation ...:`）而非 markdown 标题，`PiProfile` 用 label-line parser 在
合适的 label 后插入注入锚点，lossless 重建（不破坏 Pi prompt 结构）。缺省时
graceful degradation（找不到 label 只是不注入，不抛错）。

注入内容（与 CB 一致）：

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

注入点: system prompt 内（`PiProfile` 负责定位）。

---

## 5. 请求分类

| 类型 | 说明 |
|------|------|
| **main** | 所有请求默认都是 main |
| **auxiliary** | title-gen / compact 等由 body 特征识别，跳过 session-init / 注入 / L0 |

Pi **没有** fork / sidequery 概念。

---

## 6. 用户文本提取

Pi 的 `message.content` 是**纯字符串**（与 opencode 一致，不是 content block 数组）。
proxy 的 `piAdapter.extractUserText` 取最后一条 user message 的 content string。
图片输入通过 `image_url` content-part 透传。

---

## 7. 环境变量

见 §1.2。上游路由由 `resolveForwardTarget` 动态决定。无 Pi 专属的 proxy 配置项。

---

## 8. 常见问题

**Q: 为什么我设了 `TDAI_TEAM_ID`/`TDAI_AGENT_ID` 就不弹 picker？**
A: 这是设计。设了 = 静态预选，proxy 直接 `register directly` 跳过 form。
   想要 picker 就**不设**这两个变量（`TDAI_USER_KEY` 仍必填）。

**Q: 首轮没弹 picker，直接回了上游？**
A: 两种情况：(1) 设了静态预选变量；(2) 该业务用户名下**没有任何 Team / Agent**
   （admin 账号在 2.0.0-beta 不能持有业务资产 → 必须用业务用户）。先在面板建好
   Team + Agent 再试。

**Q: `pi -p` / 非交互场景能用吗？**
A: 能，但要用静态预选（设 `TDAI_TEAM_ID`+`TDAI_AGENT_ID`），因为 picker 需要 TUI。

**Q: 用 admin key 行吗？**
A: 不行。proxy 用 `Authorization: Bearer` 校验**业务用户**的 user_key；admin/gateway
   key 是给内部端点的。用面板 → API Key 里业务用户的 `sk-mem-...`。

**Q: 本地 skill / 历史 session 能导入 Memory Hub 吗？**
A: 暂未实现 Pi 专属的 `asset-import` 扫描器（Pi 的 skill 是 `~/.pi/agent/skills/`
   下的 .md，session 在 `~/.pi` 下）。可通过 Panel 手动导入或 `mem:sync`，专属
   扫描器作为后续 PR。

**Q: 想调试注入是否对？**
A: 临时设 `TDAI_AGENT_SOURCE=codebuddy` 回退到 battle-tested 的 CB profile
   （注入照常，锚点更粗），用来隔离是 Pi 特有问题还是通用 proxy 问题。

---

## 9. 与其他客户端的差异

| 维度 | Claude Code | CodeBuddy | OpenCode | **Pi** |
|---|---|---|---|---|
| 协议 | Anthropic Messages | OpenAI Chat | OpenAI Chat | **OpenAI Chat** |
| 配置 | env / settings.json | `~/.codebuddy/models.json` | `~/.config/opencode/opencode.json` | **env + 扩展自动发现**（无配置文件） |
| URL 前缀 | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/opencode/<spaceId>` | **`/pi/<spaceId>`** |
| Form tool | `AskUserQuestion`（原生） | `ask_followup_question`（原生） | `ask_followup_question`（原生 `question`） | **`ask_followup_question`（扩展注册的自定义工具）** |
| Form 渲染 | 客户端原生 UI | 客户端原生 UI | 客户端原生 UI | **扩展用 `ctx.ui.custom` 渲染 TUI 菜单** |
| Session ID | client 带 `x-claude-code-session-id` | client 带 `x-conversation-id` | proxy 自生成 | **扩展注入 `x-conversation-id: pi-<sid>`** |
| 注入 Profile | AnthropicAdapter | CB profile | CB profile | **`PiProfile`（label-line parser）** |
| 静态预选 | env 可预选 | — | — | **env 可预选（`TDAI_TEAM_ID`/`TDAI_AGENT_ID`）** |
| 本地资产导入 | 有 | 有 | 无 | **无（待实现）** |

---

## 10. 当前状态

- ✅ 扩展实现完成（`MemoryCore/pi-plugin`：routing + 动态 `x-conversation-id` +
  `ask_followup_question` TUI picker + 静态预选回退）
- ✅ 扩展单测 19/19 通过（form 解析 / picker 渲染 / env 回退 / provider 注册）
- ✅ proxy 侧 `pi` agent-adapter + `PiProfile` + `extractSpaceIdFromPath` allowlist
  + `credit-reporter` allowlist 已就位（零额外 proxy 改动即可走 CB form 路径）
- ✅ `/pi/<spaceId>` 路由端到端连通验证（curl 200，转发上游正常）
- ⏳ 完整 live e2e（form 弹出 + 选择回环）建议合并前用已建好 Team+Agent 的业务
   用户再跑一次（RFC 已做过 live spike 确认四轮回环）
- ⏳ Pi 专属 `asset-import` 扫描器（后续 PR）
