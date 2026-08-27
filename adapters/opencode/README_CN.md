# TencentDB Agent Memory — OpenCode 适配器

为你的 [OpenCode](https://opencode.ai) 编码智能体装上团队级持久记忆。本适配器将 OpenCode 的 LLM 请求路由到 TencentDB Agent Memory 代理，使每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每一轮对话自动将所绑定 Agent 的 L2/L3 记忆、技能与知识注入系统提示词
- **自动沉淀** — L0 原始对话自动写入 memory-core，供后续提炼

## 工作原理

```
OpenCode ──(OpenAI Chat Completions 协议)──> Memory Proxy :8096 ──> 上游 LLM
                                              │
                                              ├─ auth        (校验 sk-mem-... user_key)
                                              ├─ sessionInit (Team/Agent/Task 选择器)
                                              └─ injection   (注入 L2/L3 记忆 + 技能 + 知识)
```

代理对每个客户端使用其原生协议。OpenCode 通过 OpenAI 兼容端点以自定义 provider 方式接入，无需编写任何插件代码 —— 只需配置。

## 前置条件

1. TencentDB Agent Memory 已启动（使用主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获取业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时 `start-all.sh` 会打印；也可在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 OpenCode（`curl -fsSL https://opencode.ai/install | bash` 或 `npm i -g opencode-ai`）。

## 配置步骤

### 1. 添加 provider 配置

将本目录下的 `opencode.json` 复制到项目根目录（或合并进你现有的配置）：

```bash
cp adapters/opencode/opencode.json ./opencode.json
```

然后调整一个字段：`models` 下的模型 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。默认示例使用 `claude-sonnet-4-20250514`。

### 2. 认证

在 OpenCode 中执行：

```
/connect tencentdb-agent-memory
```

按提示粘贴你的 `sk-mem-...` user_key。密钥保存在本地 `~/.local/share/opencode/auth.json`，不会写入配置文件。

### 3. 验证

1. 在任意项目目录启动 `opencode`。
2. 打开模型选择器（`/models`）—— 应能看到 **TencentDB Agent Memory / claude-sonnet-4 (via Memory Proxy)**。
3. 选中后发送第一条消息。代理会触发会话选择器，该选择器通过 OpenCode 原生 `question` 工具渲染：用方向键 + 回车选择你的 **Team → Agent → Task**。若选择器以纯文本出现（或看到 `invalid [tool=...]`），说明请求被错误路由 —— 检查 `options.baseURL` 是否以 `/opencode/` 开头而非 `/codebuddy/`。
4. 从本轮起，所绑定 Agent 的记忆将自动注入。可以让 Agent 回忆此前会话内容进行验证。

也可以随时对随库配置做一次冒烟校验：

```bash
node adapters/opencode/validate.js
```

该脚本解析 `opencode.json`，若 `options.baseURL` 未走 `/opencode/` 路径（例如仍指向 `/codebuddy/`）则报错退出。

## 配置参考

| 字段 | 值 | 说明 |
|---|---|---|
| `npm` | `@ai-sdk/openai-compatible` | OpenCode 为自定义 provider 加载的 AI SDK 包 |
| `options.baseURL` | `http://127.0.0.1:8096/opencode/default/v1` | 代理的 OpenCode 路由族。`/opencode/` 前缀使代理将请求分类为 `agentSource=opencode`（原生 `question` 工具会话选择器的必要条件）。末尾 `default` 为记忆空间 ID（`x-tdai-service-id`）；多空间部署时按需修改 |
| `options.headers` | `x-tdai-service-id: default` | 多空间部署时显式指定服务 ID |
| `models.<id>` | 必须等于 `PROXY_UPSTREAM_MODEL` | 否则代理会因上游模型不匹配而拒绝请求 |
| 认证 | 通过 `/connect tencentdb-agent-memory` | Bearer token 即业务用户的 `sk-mem-...` user_key |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `/models` 中看不到模型 | 配置 JSON 无效 —— 检查 `opencode.json` 能否解析，且文件位于项目根目录或 `~/.config/opencode/opencode.json` |
| 代理返回 `401` | 密钥错误或缺失 —— 重新执行 `/connect tencentdb-agent-memory`；确认使用业务用户密钥而非管理员密钥 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志及 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | OpenCode 中选择的模型与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐 `opencode.json` 中的 `models` 键名 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动开启）；若此前会话已绑定 Task 会复用绑定 —— 新开一个 OpenCode 会话即可重新选择 |

## 说明

- **端点前缀**：使用 `feat/server_team` 上已落地的 OpenCode 专用路由族 —— 主路径 `POST /opencode/<spaceId>/v1/chat/completions`（`baseURL` 不带 `/v1` 时为裸尾变体 `/opencode/<spaceId>/chat/completions`），另有 `/opencode/<spaceId>/cost-guard|analyse/v1` marker 路由。代理依据路径首段分类 `agentSource`；若将 OpenCode 指向 `/codebuddy/<spaceId>`，会被分类为 `codebuddy`，导致原生 `question` 工具的会话初始化表单（`MemoryProxy/src/session/opencode/form.ts`）失效。
- **数据流**：只有提示词/补全流量经过代理；记忆数据始终保存在本地 SQLite（memory-core）中，除非你另行配置。
- **版本**：已在 OpenCode ≥ 0.6 与 TencentDB Agent Memory v3（`feat/server_team` 分支，v2.0.0 镜像）上验证。

## 许可证

MIT，与主仓库一致。
