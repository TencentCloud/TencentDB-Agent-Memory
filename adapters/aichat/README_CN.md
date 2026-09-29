# TencentDB Agent Memory — aichat 适配器

为 [aichat](https://github.com/sigoden/aichat) 装上持久团队记忆。本适配器把其 LLM 流量路由到 TencentDB Agent Memory 代理，每次聊天、Shell 助手命令与 RAG 会话自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
aichat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                        │
                                        ├─ auth        (校验 sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task 选择器)
                                        └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

aichat 通过 `~/.aichat/config.yaml` 中的 `openai-compatible` provider 类型支持**任意 OpenAI 兼容服务**（见[官方配置示例](https://github.com/sigoden/aichat/blob/main/config.example.yaml)）。其客户端以 `<api_base>/chat/completions` 构造请求 URL，并以 `Bearer` 令牌发送 API Key（已核实源码：`src/client/openai_compatible.rs` —— `format!("{api_base}/chat/completions")`）。把 `api_base` 指向代理的 `/codebuddy/<spaceId>/v1` 端点即可接入——**无需改任何代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 选择器）、**记忆注入**（绑定 Agent 的 L2/L3 记忆、技能与知识每轮混入系统提示词）与**自动沉淀**（L0 原始对话写入 memory-core）全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. aichat 已安装（`cargo install aichat`，或从 [releases](https://github.com/sigoden/aichat/releases) 下载二进制）并完成初始化（首次运行 `aichat` 会创建 `~/.aichat/`）。

## 配置步骤

### 1. 把代理添加为 openai-compatible provider

在 `~/.aichat/config.yaml` 的 `providers:` 列表中追加：

```yaml
  - type: openai-compatible
    name: tencentdb-mem
    api_base: http://127.0.0.1:8096/codebuddy/default/v1
    api_key: sk-mem-xxxxxxxx
    models:
      - name: claude-sonnet-4-20250514
        max_input_tokens: 200000
```

- `api_base` —— 代理端点；若使用其他记忆空间，把 `default` 换成对应 spaceId。**保留末尾 `/v1`**：aichat 在 `api_base` 后追加 `/chat/completions`，正好落在代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由上。
- `api_key` —— 业务用户密钥（`sk-mem-...`），以 `Authorization: Bearer` 发送。
- `models` —— 把代理的 `PROXY_UPSTREAM_MODEL` 值（如 `claude-sonnet-4-20250514`）声明为模型名。名称**必须与**代理上游模型一致，否则代理以上游不匹配为由拒绝。模型为手动声明，不涉及模型列表端点。

### 2. 切换模型并验证

1. 选择模型：`aichat --model tencentdb-mem:claude-sonnet-4-20250514`，或在 REPL 中执行 `.model tencentdb-mem:claude-sonnet-4-20250514`。
2. 发送第一条消息。代理在聊天交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从这一轮起，绑定 Agent 的记忆自动注入。向 aichat 询问之前对话记得什么即可确认。

## 配置速查

| 字段 | 值 | 说明 |
|---|---|---|
| `type` | `openai-compatible` | aichat 的通用 OpenAI 兼容客户端 |
| `name` | `tencentdb-mem`（可自定义） | 模型选择前缀：`tencentdb-mem:<model>` |
| `api_base` | `http://127.0.0.1:8096/codebuddy/default/v1` | 代理端点；`default` 为记忆空间 ID，按空间替换；**保留**末尾 `/v1` |
| `api_key` | `sk-mem-...` | Panel 创建的业务用户密钥 |
| `models[].name` | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 必须与代理上游模型一致 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| `401` / "Invalid API Key" | 必须使用 Panel 的业务用户密钥（`sk-mem-...`），不能用 `./.admin-key` 的管理员密钥 |
| 回复为空 / 上游不匹配 | 模型名与 `PROXY_UPSTREAM_MODEL` 不一致——对齐 `models[].name` 即可 |
| 每次请求都 `404` | `api_base` 末尾漏了 `/v1`（请求会打到 `/codebuddy/<spaceId>/chat/completions`）；按上文原样填写 |
| 连接被拒 | 代理未在 `:8096` 运行——检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 模型选择器中找不到模型 | aichat 只展示 provider 下已声明的模型——补上模型条目并重启 aichat |
| 会话选择器未出现 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动设置）；若前一会话已绑定任务，绑定会被复用——执行 `.new` 新开会话即可重新选择 |

## 说明

- **配置仅存于本地**：provider 配置块只保存在你的 `~/.aichat/config.yaml` 中，不进入任何提交文件；因此本适配器只包含文档（与 LobeChat / Open WebUI / LibreChat 适配器一致）。
- **全模式经过代理**：REPL 聊天、CMD 模式（`-m` / `--model`）、Shell 助手、RAG 会话与使用该模型的所有 agent 均获得记忆注入。
- **数据流**：仅提示词/补全流经代理；记忆数据保留在本地 SQLite（memory-core）中，除非你另行配置。

## 许可证

MIT，与主仓库一致。
