# TencentDB Agent Memory — Plandex 适配器

为 [Plandex](https://github.com/plandex-ai/plandex) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个 plan 自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Plandex ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (校验 sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task 选择器)
                                        └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Plandex 是终端 AI 编码引擎。其默认 OpenAI Provider 支持通过 `OPENAI_API_BASE` 环境变量自定义基础地址（[官方 README](https://github.com/plandex-ai/plandex)）；v2.2 起也可用 `plandex models custom` 将任意 OpenAI 兼容端点注册为自定义 Provider。将两者之一指向代理的 `/codebuddy/<spaceId>` 端点即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已安装 Plandex（`curl -sL https://plandex.ai/install.sh | bash`，或从源码构建——见 [README](https://github.com/plandex-ai/plandex)）。

## 配置 — 方式 A：环境变量（最快）

Plandex 默认 OpenAI Provider 支持通过 `OPENAI_API_BASE` 自定义基础地址：

```bash
cd your-project
export OPENAI_API_KEY=sk-mem-xxxxxxxx        # Panel 创建的业务用户密钥
export OPENAI_API_BASE=http://127.0.0.1:8096/codebuddy/default
plandex new
```

如使用其他记忆空间，将 `default` 替换为对应 space ID。Plandex 会自行拼接 chat-completions 路径——请原样填写上述基础端点。

随后选择名称与代理 `PROXY_UPSTREAM_MODEL` 一致的模型：

```bash
plandex models          # 查看可用模型与当前选择
```

## 配置 — 方式 B：自定义 Provider（v2.2+，显式）

`plandex models custom` 打开自定义模型配置。将代理注册为自定义 Provider 并映射模型：

```json
{
  "$schema": "https://plandex.ai/schemas/models-input.schema.json",
  "providers": [
    {
      "name": "tdb-agent-memory",
      "baseUrl": "http://127.0.0.1:8096/codebuddy/default",
      "apiKeyEnvVar": "TDB_MEM_API_KEY"
    }
  ],
  "models": [
    {
      "modelId": "claude-sonnet-4-20250514",
      "publisher": "TencentDB Agent Memory",
      "description": "Upstream model via TencentDB Agent Memory proxy",
      "maxTokens": 200000,
      "maxOutputTokens": 8192,
      "providers": [
        {
          "provider": "custom",
          "customProvider": "tdb-agent-memory",
          "modelName": "claude-sonnet-4-20250514"
        }
      ]
    }
  ]
}
```

使用前导出密钥：

```bash
export TDB_MEM_API_KEY=sk-mem-xxxxxxxx
```

## 对齐模型 ID

发送到代理的模型名**必须与 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

## 验证

1. 启动 plan：`plandex new`，然后下达任务（`plandex tell '...'`）。
2. 首次模型调用时，代理在终端交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 Plandex 此前会话记得什么即可确认。

## 配置参考

| 条目 | 值 | 说明 |
|---|---|---|
| `OPENAI_API_BASE`（方式 A） | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；`default` 为记忆空间 ID，按空间替换 |
| `OPENAI_API_KEY`（方式 A） | `sk-mem-...` | 业务用户密钥；以 `Authorization: Bearer` 发送 |
| `providers[].baseUrl`（方式 B） | `http://127.0.0.1:8096/codebuddy/default` | 同一端点，声明于自定义模型配置 |
| `providers[].apiKeyEnvVar`（方式 B） | `TDB_MEM_API_KEY` | 存放业务用户密钥的环境变量——密钥不落入配置文件 |
| 模型名 / `modelName` | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `401` / 鉴权失败 | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥；方式 B 需确认 `TDB_MEM_API_KEY` 已导出 |
| `404` | 基础地址拼写错误——必须恰为 `http://<host>:8096/codebuddy/<spaceId>`，不追加 `/v1` 或 `/chat/completions` |
| "Model Not Found" / 上游不匹配 | 模型名与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **密钥仅走环境变量**：两种方式均通过环境变量引用 API 密钥——密钥不会落入被提交的文件。
- **整个 plan 全覆盖**：`plandex tell` / `plandex continue` 的所有轮次均使用所选模型，整个 plan 获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
