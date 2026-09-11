# TencentDB Agent Memory — Pi 适配器

为你的 [Pi 编码智能体](https://pi.dev)装上团队级持久记忆。本适配器将 Pi 的 LLM 请求路由到 TencentDB Agent Memory 代理，使每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每一轮对话自动将所绑定 Agent 的 L2/L3 记忆、技能与知识注入系统提示词
- **自动沉淀** — L0 原始对话自动写入 memory-core，供后续提炼

## 工作原理

```
Pi ──(OpenAI Chat Completions 协议)──> Memory Proxy :8096 ──> 上游 LLM
                                         │
                                         ├─ auth        (校验 sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task 选择器)
                                         └─ injection   (注入 L2/L3 记忆 + 技能 + 知识)
```

Pi 通过 `~/.pi/agent/models.json` 支持自定义 OpenAI 兼容 provider。代理在 `/codebuddy/<spaceId>` 端点上说 OpenAI Chat Completions 协议，因此 Pi 只需**纯配置接入**——无需编写任何扩展代码。

## 前置条件

1. TencentDB Agent Memory 已启动（使用主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获取业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时 `start-all.sh` 会打印；也可在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 Pi（`curl -fsSL https://pi.dev/install.sh | bash`，或访问 [pi.dev](https://pi.dev)）。

## 配置步骤

### 1. 注册 provider

将本目录的 `models.json` 合并进 `~/.pi/agent/models.json`（文件不存在则新建——Pi 每次打开 `/model` 时都会重新加载，无需重启）：

```bash
mkdir -p ~/.pi/agent
# 若 ~/.pi/agent/models.json 尚不存在：
cp adapters/pi/models.json ~/.pi/agent/models.json
# 否则将 "tencentdb-agent-memory" 块合并进现有 "providers" 对象
```

然后调整一个字段：模型 `id` **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。默认示例使用 `claude-sonnet-4-20250514`。

### 2. 提供密钥

二选一：导出配置中引用的环境变量（请求时解析）：

```bash
export TDS_AGENT_MEMORY_KEY="sk-mem-..."   # 你的业务用户密钥
```

或在 `models.json` 中省略 `apiKey`，在 Pi 内执行 `/login tencentdb-agent-memory` 将密钥存入 `auth.json`。

### 3. 验证

1. 在任意项目目录启动 `pi`。
2. 打开模型选择器（`/model` 或 `Ctrl+L`）—— 应能看到 **tencentdb-agent-memory / claude-sonnet-4 (via Memory Proxy)**。未配置认证的模型会保持不可用状态，若显示灰色请检查密钥。
3. 选中后发送第一条消息。代理会触发会话选择器：选择你的 **Team → Agent → Task**。
4. 从本轮起，所绑定 Agent 的记忆将自动注入。可以让 Pi 回忆此前会话内容进行验证。

## 配置参考

| 字段 | 值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8096/codebuddy/default` | 代理的 OpenAI 兼容端点。末尾 `default` 为记忆空间 ID（`x-tdai-service-id`）；多空间部署时按需修改 |
| `api` | `openai-completions` | Pi 对 OpenAI Chat Completions 服务端兼容性最好的 API 类型 |
| `apiKey` | `$TDS_AGENT_MEMORY_KEY` | 环境变量解析；Pi 也支持 `!command`、`${VAR}` 或直接写 `sk-mem-...` |
| `headers` | `x-tdai-service-id: default` | 多空间部署时显式指定服务 ID |
| `models[].id` | 必须等于 `PROXY_UPSTREAM_MODEL` | 否则代理会因上游模型不匹配而拒绝请求 |
| `models[].contextWindow` | `200000` | 按上游模型调整 |
| `models[].cost` | 全 0 | 上游计费不经过 Pi；置 0 使 Pi 的成本显示如实反映代理链路 |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `/model` 列表中无此模型 | `models.json` 解析失败或不在 `~/.pi/agent/models.json`；用 `pi --list-models` 检查 |
| 模型可见但不可用 | 未配置认证 —— 导出 `TDS_AGENT_MEMORY_KEY` 或执行 `/login tencentdb-agent-memory` |
| 代理返回 `401` | 密钥错误 —— 确认使用业务用户密钥（`sk-mem-...`）而非管理员密钥 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志及 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | 所选模型与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐 `models[].id` |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动开启）；若此前会话已绑定 Task 会复用绑定 —— 新开一个 Pi 会话即可重新选择 |

## 说明

- **端点前缀**：本适配器当前复用代理的 OpenAI 兼容端点（`/codebuddy/<spaceId>`），该端点对所有 OpenAI 兼容客户端协议一致。待上游提供专用前缀后，仅需修改 `baseUrl`。
- **无需 MCP**：Pi 有意不内置 MCP；本适配器遵循 Pi 原生的 `models.json` provider 机制。
- **数据流**：只有提示词/补全流量经过代理；记忆数据始终保存在本地 SQLite（memory-core）中，除非你另行配置。
- **版本**：已在 Pi 的 `models.json` provider 规范（自定义 `baseUrl` + `api`）与 TencentDB Agent Memory v3（`feat/server_team` 分支，v2.0.0 镜像）上验证。

## 许可证

MIT，与主仓库一致。
