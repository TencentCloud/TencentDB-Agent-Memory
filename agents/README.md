# Agents

Memory Proxy 目前适配了 7 类 AI Agent 客户端，各自协议、会话初始化方式、注入逻辑差异显著。

## 快速开始

### 方式一：人工运行脚本

```bash
cd <本仓库根目录>
bash agents/setup-proxy.sh
```

交互式向导，一步步引导你完成 Agent 接入 Proxy 的配置：
1. 自动扫描现有配置（有则复用，无需重复填写）
2. 选择要配置的 Agent
3. 填写模型 ID
4. 健康探测（验证 Proxy 连通性）
5. 写入配置文件（自动备份原文件为 `.bak`）
6. 可选：导入本地 skill/对话到团队记忆

支持所有 7 个 Agent，每次配一个，多次运行配置不同 Agent。

### 方式二：通过 AI Agent 辅助配置（Skill）

让 Claude Code / CodeBuddy 等 AI Agent 根据 skill 引导你完成配置，agent 会逐步探测环境、验证连通性、动态选择。

#### 第 1 步：把 agents 目录复制到 home 下

```bash
cd <本仓库根目录>
cp -r agents ~/agents
```

#### 第 2 步：在 AI Agent 对话中使用以下 prompt

> 注意：执行脚本前 agent 需要先 `cd ~/agents` 进入目录。

**配置新 Agent 接入 Proxy：**

```
请阅读 ~/agents/skills/setup-proxy/SKILL.md 这个 skill 文档，然后按照里面的步骤引导我完成 Agent 接入 Memory Proxy 的配置。
```

**配置指定 Agent（如 Claude Code）：**

```
请阅读 ~/agents/skills/setup-proxy/SKILL.md，帮我配置 Claude Code 接入 Memory Proxy。我的 proxy 地址是 http://localhost:8096，实例 ID 是 default。
```

**配置 Hermes/OpenClaw（需要 header 预选）：**

```
请阅读 ~/agents/skills/setup-proxy/SKILL.md，帮我配置 Hermes 接入 Memory Proxy。面板地址是 http://localhost:8125，帮我从面板拉取 team/agent 列表来选择。
```

**只做健康探测（不写配置）：**

```
请阅读 ~/agents/skills/setup-proxy/SKILL.md，帮我探测一下 http://localhost:8096 这个 proxy 是否正常，用 codebuddy 协议，模型 claude-opus-4.7。
```

> ℹ️ Skill 文件位于 `agents/skills/setup-proxy/SKILL.md`，配套脚本 `agents/skills/setup-proxy/setup-proxy.sh`。Agent 负责逐步收集信息和验证环境，最终调用脚本的 `--non-interactive` 模式完成配置写入。

---

每个子目录对应一个 agent，内含：
- `README.md` — 接入配置、适配方式、Session Init 流程、常见问题
- `asset-import.md` — 把该客户端本地 skill / memory / session 导入 Memory Hub（单文件手册）
- `asset-import.ts` — 该客户端扫盘实现，统一入口为仓库根 `agents/asset-import.ts`，用 `--source <name>` 指定 IDE
- 后续可放：适配过程记录、调试脚本、抓包 fixtures 等

---

## 快速对照表

| Agent | 协议 | Session Init 方式 | Form Tool | 分页 | Default/Plan Gate | Headless Bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | 交互式 Form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | 交互式 Form | `ask_followup_question` | ❌ (无上限) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | 交互式 Form + Default Gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | 交互式 Form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (静默透传) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | 交互式 Form + Headless Bypass | `ask_user_question` | ❌ (无上限) | ❌ | ✅ (无 tool 时) |
| [Hermes](./hermes/) | OpenAI Chat Completions | Header 预选（无 Form） | N/A | N/A | N/A | ✅ (header 缺失时) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | Header 预选（无 Form） | N/A | N/A | N/A | ✅ (header 缺失时) |

---

## 本地资产导入

把各客户端磁盘上的 skill / memory / 历史 session 导入 Memory Hub。每个客户端一个扫描文件，可直接跑：

```bash
# 交互式导入（运行后逐项 y/N 询问 skill / memory / session）
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# 非交互全量导入（脚本/CI）
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | 手册 |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| Hermes | [asset-import.md](./hermes/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID Header 速查

| Agent | 主 Header | 备选 |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| Hermes | `x-conversation-id` | — (用户静态配置) |
| OpenClaw | `x-conversation-id` | — (用户静态配置) |

---

## 客户端配置方式

| Agent | 配置方式 | 配置文件 / 变量 | Key 传递 |
|-------|----------|-----------------|----------|
| Claude Code | 环境变量 或 配置文件 | `~/.claude/settings.json` 或 env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | 配置文件 | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | 配置文件 | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | 配置文件 | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | 配置文件 | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML 环境变量引用 |
| Hermes | 配置文件 | `~/.hermes/config.yaml` | YAML `api_key` + headers |
| OpenClaw | 配置文件 | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## 路由规则

```
/:agent/:spaceId/v1/messages          → Anthropic 协议 (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, Hermes, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat 无 v1 前缀 (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API 无 v1 前缀 (Codex, WB-desktop)
```

---

## Header 预选（通用，所有 agent 均可使用）

除了交互式 Form 之外，**所有 agent** 都支持通过 HTTP Header 直接完成 session 注册，跳过表单交互。适用于：
- 无法响应 form（如 Hermes / OpenClaw）
- 想跳过表单加速首帧（如 CI/CD 自动化场景）
- 第三方平台 / 自行开发的 Agent

### 必须携带的 Header

| Header | 说明 |
|--------|------|
| `Authorization: Bearer <user_key>` | 业务用户的 API Key（从面板获取） |
| `x-team-id` | 团队 ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | 任务 ID（当前版本必填） |
| `x-conversation-id` | 会话标识，由客户端自行生成和管理 |

以上 header 齐全 → Proxy 直接完成 session 注册 + 注入资产，不弹 form。  
任一缺失 → 走交互式 form（如果客户端支持）或 session bypass（不支持 form 时）。

### 其他平台接入

任何兼容 OpenAI API 的平台均可接入，将 API base URL 指向 Proxy：

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`：必须从 Proxy 支持的值中选用：`claude-code`、`codebuddy`、`workbuddy`、`codex`、`hermes`、`openclaw`。其他平台可伪装成其中之一接入（如使用 `codebuddy`）
- `<spaceId>`：memory 实例 ID（本地部署固定为 `default`）

---

## 新 Agent 接入流程概览

1. **抓包** — 用 mitmproxy 抓 3~5 种典型请求 (main / aux / title-gen)，存入 `docs/<agent>-recon/`
2. **识别协议** — 确定 wire protocol (Anthropic / Chat / Responses)
3. **确定 Session ID 来源** — 找 header 或 body 里的唯一会话标识
4. **选择 Session Init 策略** — 有 tool → 交互式 form；无 tool → header 预选 / headless bypass
5. **分类辅助请求** — 识别 title-gen / compact / fork 等不需要走全链路的请求
6. **实现 Handler / 复用** — 协议相同的可共享 handler (如 dsh 复用 CB 的 handleChatCompletions)
7. **注入 Profile** — 按客户端 system prompt 格式定义注入模板
8. **E2E 验证** — 跑完整链路确认 session-init + 注入 + 归档正常

详见各子文档。
