# TencentDB Agent Memory — trpc-agent-go 适配器

为基于 [trpc-agent-go](https://github.com/trpc-group/trpc-agent-go) 构建的智能体装上持久记忆，由 TencentDB Agent Memory 提供存储与记忆流水线。trpc-agent-go 上游内置了集成包 `memory/tencentdb`，本适配目录提供快速上手、接入指南和可运行的示例，把它与 TencentDB Agent Memory 部署连接起来。

接入后，每个会话自动获得：

- **对话捕获** —— 每轮完成的 user/assistant 对话会流式发送到 gateway（`POST /capture`），进入 L0 → L3 记忆流水线
- **自动召回** *（需显式开启）* —— 每次模型调用前注入相关记忆上下文（`POST /recall`）
- **检索工具** —— `tdai_conversation_search`（按 session 作用域，默认开启）和 `tdai_memory_search`（长期记忆，需显式开启），让模型可以主动查询
- **可选的上下文卸载 v2** —— 大体积工具结果可交给 gateway 外置化与压缩

## 工作原理

```
trpc-agent-go Runner
  ├─ session.Ingestor ──(POST /capture)───────┐
  ├─ recall plugin ────(POST /recall)─────────┤
  └─ tdai_* tools ─────(POST /search/*)───────┤
                                              ▼
                     Memory Core Gateway（端口 8420）
                                 │
                          L0 → L3 记忆流水线
                    （捕获 · 提取 · 存储 · 召回）
```

适配器对接的是 **memory-core gateway**（默认 `:8420`），记忆引擎运行在其中。这是框架级集成：Go 开发者 `import trpc.group/trpc-go/trpc-agent-go/memory/tencentdb`，并继续完全掌控 Runner、Session、Plugin 与 Tool 的生命周期。它与 OpenCode 等编码智能体客户端使用的 OpenAI 兼容代理（`:8096`）是两个不同的接入面。

## 前置条件

1. TencentDB Agent Memory 已在本地运行：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   请在 `.env` 中设置 `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` —— 记忆引擎使用该 LLM 完成提取、总结与召回。gateway 监听 `MEMORY_CORE_PORT`（默认 `8420`）。

2. Go 1.21+ 以及 trpc-agent-go **v1.11.1 及以上**（`memory/tencentdb` 包已在上游发布）：

   ```bash
   go get trpc.group/trpc-go/trpc-agent-go@v1.11.1
   ```

3. 一个 OpenAI 兼容的 API Key，供智能体自身的对话模型使用（示例读取 `OPENAI_API_KEY`）。

## 运行示例

```bash
cd adapters/trpc-agent-go/example
export OPENAI_API_KEY="sk-..."          # 智能体的对话模型
go run . -model deepseek-chat           # 或你所使用供应商的模型名
```

然后跨会话验证记忆效果：

```text
You: 记住：我的项目代号是 Apollo Lake，部署窗口是周五晚上。
you: /new
you: 我的项目代号和部署窗口是什么？
```

第一轮对话会被 gateway 捕获；`/new` 会 flush 当前会话并开启新会话；随后的问题应能基于召回的记忆回答（提取是异步的，稍等几秒，或保持默认的 `-turn-wait`）。

## 接入你自己的项目

```go
import (
    memorytencentdb "trpc.group/trpc-go/trpc-agent-go/memory/tencentdb"
    "trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
    "trpc.group/trpc-go/trpc-agent-go/model/openai"
    "trpc.group/trpc-go/trpc-agent-go/runner"
    sessioninmemory "trpc.group/trpc-go/trpc-agent-go/session/inmemory"
)

memSvc, err := memorytencentdb.NewService(
    memorytencentdb.WithGatewayURL("http://127.0.0.1:8420"),
    // opt-in：这两项会读取 gateway 的共享长期存储。只有当 gateway
    // 能保证按租户隔离时才开启（本地单人 sidecar 场景没有问题）。
    memorytencentdb.WithRecallEnabled(true),
    memorytencentdb.WithMemorySearchTool(true),
)
if err != nil {
    return err
}
defer memSvc.Close()

agent := llmagent.New(
    "assistant",
    llmagent.WithModel(openai.New("deepseek-chat")),
    llmagent.WithTools(memSvc.Tools()),      // tdai_* 检索工具
)

r := runner.NewRunner(
    "my-app",
    agent,
    runner.WithSessionService(sessioninmemory.NewSessionService()),
    runner.WithSessionIngestor(memSvc),      // 把每轮对话流式发送到 /capture
    runner.WithPlugins(memSvc.Plugin()),     // 模型调用前自动召回
)
defer r.Close()
```

对该集成**不要**使用 `runner.WithMemoryService(...)` —— 记忆语义由 gateway 拥有，适配面是 `Ingestor` + `Plugin` + `Tools`。

## 配置参考

| 选项 | 作用 | 默认值 |
|---|---|---|
| `WithGatewayURL(url)` | memory-core gateway 地址。 | `http://127.0.0.1:8420` |
| `WithAPIKey(key)` | 发送 `Authorization: Bearer <key>`；gateway 以 `TDAI_GATEWAY_API_KEY` 启动时必填。 | 无 |
| `WithTimeout(d)` | gateway HTTP 客户端超时。 | `5s` |
| `WithRecallEnabled(bool)` | 自动召回 plugin（opt-in；读取共享存储）。 | `false` |
| `WithMemorySearchTool(bool)` | 暴露 `tdai_memory_search`（opt-in；读取共享存储）。 | `false` |
| `WithConversationSearchTool(bool)` | 暴露按 session 作用域的 `tdai_conversation_search`。 | `true` |
| `WithStandardAliases(bool)` | 额外暴露标准 `memory_search` 别名。 | `false` |
| `WithToolPrefix(p)` | 原生工具名前缀。 | `tdai` |
| `WithIngestWorkers(n)` / `WithIngestQueueSize(n)` / `WithIngestJobTimeout(d)` | 异步捕获流水线调优。 | `1` / `10` / `30s` |
| `WithSessionKeyFunc(fn)` | 自定义 session → gateway `session_key` 的映射。 | `base64url(app):base64url(user):base64url(session)` |
| `WithContextOffload(cfg)` | 显式短期上下文卸载 v2（需 `ServiceID`；见上游文档）。 | 关闭 |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 启动报 `gateway is not ready` | 服务未运行 —— 用 `deploy/global-images/start-all.sh` 启动并检查 `MEMORY_CORE_PORT`；用 `curl http://127.0.0.1:8420/health` 验证。 |
| gateway 返回 `401` | gateway 启动时配置了 API key —— 通过 `WithAPIKey(...)` 传入相同值。 |
| 模型从不调用记忆工具 | 工具未注册到 agent —— 加上 `llmagent.WithTools(memSvc.Tools())`。 |
| 新会话中召回不到记忆 | 缺少 `WithRecallEnabled(true)`；或提取尚未完成（异步执行 —— 稍等几秒重试）。 |
| 对话从未到达 gateway | 缺少 `runner.WithSessionIngestor(memSvc)`，或 session 的 app/user/session ID 存在空值（三者均必填）。 |
| 担心跨用户记忆泄漏 | 除非 gateway 保证按租户隔离，否则不要开启 `WithRecallEnabled` 与 `WithMemorySearchTool`；按 session 作用域的捕获与对话搜索保持安全。 |

## 测试

示例自带冒烟测试，基于假 gateway 验证适配器接线（健康检查、工具暴露、捕获载荷、会话 flush、Bearer 认证）—— 无需启动服务或 LLM：

```bash
cd adapters/trpc-agent-go/example
go test ./...
```

## 说明

- **版本**：已在 trpc-agent-go `v1.11.1` 与 TencentDB Agent Memory v2 镜像（`feat/server_team` 分支）上验证。
- **上游文档**：完整的选项语义、上下文卸载 v2 行为与多租户指引见 trpc-agent-go 仓库（`docs/mkdocs` → memory → tencentdb）及 `examples/memory/tencentdb`。
- **数据流**：只有对话轮次与检索查询经过 gateway；记忆数据默认保存在本地存储（SQLite），除非另行配置。

## 许可证

MIT，与主仓库一致。
