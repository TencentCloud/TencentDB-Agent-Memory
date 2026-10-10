# TencentDB Agent Memory — aider 适配器

为 [aider](https://aider.chat) 装上团队级持久记忆。本适配器将 aider 的 LLM 请求路由到 TencentDB Agent Memory 代理，使每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每一轮对话自动将所绑定 Agent 的 L2/L3 记忆、技能与知识注入系统提示词
- **自动沉淀** — L0 原始对话自动写入 memory-core，供后续提炼

## 工作原理

```
aider ──(OpenAI Chat Completions 协议)──> Memory Proxy :8096 ──> 上游 LLM
                                            │
                                            ├─ auth        (校验 sk-mem-... user_key)
                                            ├─ sessionInit (Team/Agent/Task 选择器)
                                            └─ injection   (注入 L2/L3 记忆 + 技能 + 知识)
```

aider 支持连接任意 OpenAI 兼容端点。代理在 `/codebuddy/<spaceId>` 端点上说 OpenAI Chat Completions 协议，因此 aider 只需**环境变量 + 配置**即可接入——无需任何代码改动。

## 前置条件

1. TencentDB Agent Memory 已启动（使用主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获取业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时 `start-all.sh` 会打印；也可在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 aider（`python -m pip install aider-install && aider-install`）。

## 配置步骤

### 1. 将 aider 指向代理

```bash
export OPENAI_API_BASE=http://127.0.0.1:8096/codebuddy/default
export OPENAI_API_KEY=sk-mem-...        # 你的业务用户密钥
```

或将本目录的 `aider.conf.yml` 复制到项目根目录（其中设置了 `model` 和 `openai-api-base`），密钥仅通过环境变量提供，避免进入版本库。

### 2. 对齐模型名

`openai/` 前缀后的模型名**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。默认示例使用 `claude-sonnet-4-20250514`：

```bash
aider --model openai/claude-sonnet-4-20250514
```

### 3. 验证

1. 在项目目录启动 aider。
2. 发送第一条消息。代理会在终端交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，所绑定 Agent 的记忆将自动注入。可以让 aider 回忆此前会话内容进行验证。

## 配置参考

| 项目 | 值 | 说明 |
|---|---|---|
| `OPENAI_API_BASE` | `http://127.0.0.1:8096/codebuddy/default` | 代理的 OpenAI 兼容端点；末尾 `default` 为记忆空间 ID，多空间时对应修改 |
| `OPENAI_API_KEY` | `sk-mem-...` | 面板创建的业务用户密钥；aider 以 `Authorization: Bearer` 发送 |
| `--model` | `openai/<PROXY_UPSTREAM_MODEL>` | 否则代理会因上游模型不匹配而拒绝请求 |
| `aider.conf.yml` | 可选便捷配置 | 设置 `model` + `openai-api-base`；切勿在其中写密钥 |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 启动时出现 "Unknown model" 警告 | 自定义模型的预期行为 —— aider 会对其不认识的模型发出警告；只要上游模型能力足够，编辑功能不受影响 |
| 代理返回 `401` | 密钥错误或缺失 —— 确认 `OPENAI_API_KEY` 为业务用户密钥（`sk-mem-...`）而非管理员密钥 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志及 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | `openai/<model>` 与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐两者 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动开启）；若此前会话已绑定 Task 会复用绑定 —— 新开一个 aider 会话即可重新选择 |

## 说明

- **终端原生**：aider 是终端工具，代理的 Team → Agent → Task 交互式选择器以内联方式在终端呈现，与 CodeBuddy 的终端流程一致。
- **数据流**：只有提示词/补全流量经过代理；记忆数据始终保存在本地 SQLite（memory-core）中，除非你另行配置。
- **版本**：已在 aider 的 OpenAI 兼容接入路径（`OPENAI_API_BASE` + `openai/<model>`，见官方文档）与 TencentDB Agent Memory v3（`feat/server_team` 分支，v2.0.0 镜像）上验证。

## 许可证

MIT，与主仓库一致。
