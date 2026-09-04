# Hermes

> agentSource: `hermes` | 协议: OpenAI Chat Completions | Session Init: 交互式 Form（`clarify`）默认 + Header 预选快速通道
>
> 本地历史导入 Memory Hub：见 [资产导入手册](./asset-import.md)。

---

## 1. 客户端接入配置

Hermes 通过**配置文件**配置。文件路径按平台不同（hermes 的 `HERMES_HOME`）：

| 平台 | 路径 |
|------|------|
| Linux / macOS | `~/.hermes/config.yaml` |
| **Windows** | `%LOCALAPPDATA%\hermes\config.yaml`（即 `C:\Users\<you>\AppData\Local\hermes\`，**不是** `~/.hermes`） |

⚠️ 实测（hermes 0.20.6）：`model.provider` 引用的名字必须在顶层 `providers:` 段里有定义（承载 base_url / api_key），只把 base_url 写在 `model:` 段下会报 `No inference provider configured` / `Unknown provider '<name>'`。推荐写法：

```yaml
model:
  default: <模型名，如 deepseek-v4-flash>
  provider: tdaimemory      # 指向 providers 段的 key；同名 profile 提供行为钩子（见 §6）

providers:
  tdaimemory:
    base_url: http://<proxy-host>:8096/hermes/<spaceId>/v1
    api_key: <业务用户的 sk-mem-... user_key>
```

字段说明：
- `base_url` — Proxy 地址 + `/hermes/<spaceId>/v1`；`default` 是 memory 实例 ID（spaceId）。**以 `/v1` 结尾**（hermes 会 POST `{base_url}/chat/completions`）
- `api_key` — 业务用户的 `user_key`（从面板获取）
- 自定义 provider 的 api_mode 恒为 OpenAI Chat Completions，与 codebuddy / dsh 同族

请求路径：`POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| 来源 | Header | 说明 |
|------|--------|------|
| 推荐 | `x-conversation-id`（provider 插件动态注入） | 见 §6，hermes 从自身的 `session_id` 自动生成，无需手动管理 |
| 备选 | `x-conversation-id`（配置文件静态指定） | 每次新对话需手动更换 |

⚠️ Hermes 默认**不发送**任何会话标识 header。表单跨轮续跑（以及 session 状态保持）依赖稳定的 `x-conversation-id`，强烈建议用 §6 的 provider 插件自动注入。

---

## 3. Session Init（会话初始化）

### 3.1 默认路径：交互式 Form（clarify）

hermes CLI / gateway 模式内置交互式提问工具 **`clarify`**（CLI 方向键面板、消息平台按钮/数字列表）。请求里带 `clarify` 工具时，proxy 会像对 CodeBuddy / Claude Code / dsh / opencode 一样弹出 **Team → Agent → Task 选择表单**：

- Tool name: `clarify`（hermes 原生 tool，非伪造工具名）
- Call ID prefix: `call_hermes_session_init_`
- 分页：hermes clarify 单题最多 4 个选项（`MAX_CHOICES=4` 硬上限），team/agent/task 超过 4 个候选时自动分页（"更多 →" 翻页）
- 表单 UI 自带 "Other (type your answer)" 自由文本行，回复"跳过 / skip / 不关联"直接 bypass session-init

### 3.2 快速通道：Header 预选

在配置里静态携带身份 header 即可跳过全部表单（0 轮交互，直接注册）：

```yaml
model:
  extra_headers:            # 或 providers.<name>.extra_headers，两者等价
    x-team-id: <team_id>
    x-agent-id: <agent_id>
    x-task-id: <task_id>    # 可选；缺省时仅绑定 Team 和 Agent，召回范围放宽到该 Agent
```

Header 值必须命中该 user_key 在内核可见的 teams[]，否则视为 mismatch 走 fallback（bypass 或回表单）。

### 3.3 无头形态：自动 bypass

hermes 的 `api-server` / `acp` 发行版不内置 `clarify` 工具（无交互 UI）。请求 `tools` 缺失、为空或不含 `clarify` 时，proxy 将其视为 headless 并**自动 bypass session-init**（直接透传，不弹表单），与 dsh headless 同语义。

实测（0.20.6）`hermes -z`（oneshot）同样走 bypass：oneshot 无持久 session_id → 插件不注入 `x-conversation-id` → proxy 侧 `conversationId=null`，session-init 直接跳过（日志 `injectedSkipped=true`）。CLI/gateway 交互模式才会走 §3.1 的表单流。

---

## 4. 请求分类

所有请求均为 **main**。hermes 的 context compaction / title 等 aux 请求走同一 base_url，无独立指纹（后续抓包确认后可在 proxy 侧补分流）。

---

## 5. 注入 Profile

与 CB 相同——注入到 system message（`<session_context>` / `<skill_tools>` / `<tdai_memory_tools>` 等块）。

---

## 6. 动态 x-conversation-id（provider 插件）

hermes 的 provider profile 支持 `build_api_kwargs_extras(session_id=...)` 钩子按会话动态注入 header（OpenRouter `x-grok-conv-id` 同款机制）。把 [`tdaimemory-provider-plugin/`](./tdaimemory-provider-plugin/) 拷到 hermes 插件目录即可（Windows 把 `~/.hermes` 换成 `%LOCALAPPDATA%\hermes`，见 §1）：

```bash
mkdir -p ~/.hermes/plugins/model-providers
cp -r agents/hermes/tdaimemory-provider-plugin ~/.hermes/plugins/model-providers/tdaimemory
```

然后让 `model.provider` 引用顶层 `providers:` 中指向 MemoryProxy 的条目。Hermes
0.20.x 会在运行时把 named custom provider 归一化为 `custom`；本插件覆盖的正是该
profile，并在实际 `base_url` 含 `/hermes/` 时注入 header：

```yaml
model:
  default: <模型名>
  provider: tdaimemory

providers:
  tdaimemory:
    base_url: http://<proxy-host>:8096/hermes/<spaceId>/v1
    api_key: <业务用户的 sk-mem-... user_key>
```

> ⚠️ 实测（hermes 0.20.6）：`ProviderProfile` 是 dataclass，子类必须用 `@dataclass` 并给 `name` 字段默认值（`name: str = "tdaimemory"`）；直接类属性赋值再无参实例化会报 `missing 1 required positional argument: 'name'`。本仓库的 [`tdaimemory-provider-plugin/__init__.py`](./tdaimemory-provider-plugin/__init__.py) 已按此写法实现。

之后每个 hermes 会话的请求自动携带 `x-conversation-id: ses_<session_id>`，无需手动维护。`__init__.py` 里的 `providers` 导入报红属正常——该模块只在 hermes 运行环境内可解析。

MemoryProxy 的 `/hermes/` endpoint 不提供 OpenAI `/models`，因此插件仅对该 endpoint
跳过 model listing；Ollama、vLLM、llama.cpp 等其他 custom endpoint 继续保留 Hermes
默认 health-check 行为。

**插件自测**：目录内带 `selftest.py`（不依赖 pytest），在装有 hermes-agent 的环境验证 custom 覆盖、proxy 地址注入、其他 custom 端点零影响、oneshot、内置 quirk、reasoning 与 model listing 行为：

```bash
HERMES_AGENT_DIR=/path/to/hermes-agent python selftest.py   # 全 PASS 即插件工作正常
```

注意：**oneshot 模式（`hermes -z`）不注入此 header**（oneshot 无持久 session_id），proxy 侧对应跳过 session-init 直接透传（见 §3.3），属预期行为。

---

## 7. 常见问题

**Q: 记忆注入没生效？**  
A: 检查是否触发了表单但被 bypass（proxy 日志搜 `session-init:cb` / `bypass`）。无头形态（api-server）下请改用 §3.2 的 Header 预选。

**Q: 表单不弹，直接透传了？**

A: proxy 检测到请求 tools 里没有 `clarify` → 判定为无头形态。确认 hermes 运行在 CLI / gateway 交互模式，且没有把 clarify 工具集禁用。

**Q: 表单弹了但每次都重新弹？**

A: `x-conversation-id` 不稳定导致表单跨轮续跑失败。用 §6 的 provider 插件动态注入，或确认配置里的静态值没被中途更换。

**Q: 怎么获取 team_id / agent_id / task_id？**  
A: 登录面板 → 对应页面 → 详情里有 ID 字段。或用面板 API `team/list`、`agent/list`、`task/list` 查询。

**Q: 不想绑 Task 怎么办？**  
A: 不带 `x-task-id` 即可——会话仅绑定 Team 和 Agent，召回范围放宽到该 Agent 的全部记忆。
