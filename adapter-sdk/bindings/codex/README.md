# Codex 绑定（最小示例）

本目录用**几十行**证明 SDK 的核心主张：接入新平台只需实现一个 `PlatformBinding`。
HTTP 传输、错误处理、工具编排全部复用 `adapter-sdk/src`。

## 接入点

- **捕获**：Codex 的 `notify` 程序在每轮结束时被调用，携带一个 JSON 参数（`agent-turn-complete`）。`notify.ts` 解析它并写入记忆。

  在 `~/.codex/config.toml` 配置：
  ```toml
  notify = ["npx", "tsx", "/ABS/PATH/adapter-sdk/bindings/codex/notify.ts"]
  ```
  可选：用 `CODEX_SESSION_KEY` 提供稳定会话键（Codex notify 不含会话 id）。

- **工具**：Codex 支持 MCP server（`config.toml` 的 `[mcp_servers]`）。工具暴露与平台无关，直接复用 `MemoryAdapter.listTools()/handleToolCall()`——可仿照 `../claude-code/mcp-server.ts` 换上 `CodexBinding` 即可。

- **召回**：Codex 无「prompt 前」钩子，因此召回以 `memory_search` 工具形式提供，而非自动注入。

## 与 Claude Code 绑定的对比

对比 [`binding.ts`](binding.ts) 与 [`../claude-code/binding.ts`](../claude-code/binding.ts)：后者多出的只是 transcript 解析这类**平台专属**逻辑，其余能力完全来自 SDK。这正是「统一 SDK，一个接口接入」的体现。
