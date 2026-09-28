# 在 Codex 中使用 TencentDB Agent Memory

Codex 使用两种接入方式，底层复用同一个 Gateway HTTP client。stdio MCP server 向模型暴露工具；生命周期 Hook 则直接调用 `MemoryTools`，确定性执行自动 recall 与 capture。Hook 请求不会经过 stdio MCP server。

| Codex 事件 | MCP 操作 | 行为 |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | 每轮开始前召回记忆，并通过 `additionalContext` 注入。 |
| `Stop` | `tdai_memory_capture` | 每轮完成后保存原始 prompt 和最终回复。 |

Codex 当前没有 `SessionEnd` Hook，因此 Codex adapter 不会自动调用 `tdai_session_end`。

## 启动 Gateway

在本仓库中安装依赖并启动现有 Gateway：

```bash
npm install --ignore-scripts
node --import tsx src/gateway/server.ts
```

Gateway 默认监听 `http://127.0.0.1:8420`。stdio MCP adapter 会连接这个地址，并把记忆工具暴露给 Codex。

如果 Gateway 配置了 Bearer token，请在启动 Codex 前导出相同 token：

```bash
export TDAI_GATEWAY_API_KEY="your-gateway-token"
```

Hook 和 MCP 模板会直接调用本仓库 `node_modules` 中的 `tsx` CLI，因此需要保留本仓库及已安装依赖。

## 配置 MCP server

把 [`integrations/codex/config.toml.example`](../integrations/codex/config.toml.example) 合并到 `~/.codex/config.toml`，或者受信任项目的 `.codex/config.toml`。

把 `/absolute/path/to/TencentDB-Agent-Memory` 替换为本仓库绝对路径。该配置会把 `src/adapters/mcp/stdio.ts` 作为标准 stdio MCP server 启动。

在 Codex 中检查：

```text
/mcp
```

`memory_tencentdb` server 提供：

- `tdai_memory_recall`
- `tdai_memory_capture`
- `tdai_session_end`
- `tdai_memory_search`
- `tdai_conversation_search`

模型需要更多历史细节时可以主动调用 search 工具；自动 recall 和 capture 仍由 Codex 生命周期 Hook 触发。

## 配置 Codex Hook

把 [`integrations/codex/hooks.json`](../integrations/codex/hooks.json) 复制到以下任一位置：

- `~/.codex/hooks.json`：用于所有受信任项目。
- `<project>/.codex/hooks.json`：只用于一个受信任项目。

把 `/absolute/path/to/TencentDB-Agent-Memory` 替换为本仓库绝对路径。启动 Codex 后打开 `/hooks`；Codex 会要求审查并信任新增或变化的 command Hook。

适配器读取以下可选环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | 生命周期 Hook 与 MCP adapter 共用的 Gateway 地址。 |
| `TDAI_GATEWAY_API_KEY` | 未设置 | 发送给 Gateway 的 Bearer token。 |
| `TDAI_CODEX_STATE_DIR` | `~/.memory-tencentdb/codex-adapter` | 在不同 Hook 进程间共享 prompt 和 capture 去重状态。 |

当前一个 Gateway 实例对应一个记忆命名空间；这些 adapter 环境变量不提供用户级命名空间隔离。

适配器只在该目录中暂存尚未 capture 的 prompt 和短期去重标记。遗留的 prompt 与成功标记会在 24 小时后自动清理；被超时或异常终止的 capture claim 最多保留 60 秒，之后可由下一次 `Stop` 恢复。

## 故障降级

Codex adapter 采用 fail-open：

- Gateway recall 失败时返回 `{}`，Codex 继续处理原始 prompt。
- Gateway capture 失败时只写 stderr，不阻止 Codex 结束本轮。
- Capture 失败后保留 prompt，后续重复 `Stop` 可以重试。
- Capture 成功后写入本地标记，防止相同 `session_id + turn_id` 被重复保存。
- Capture 采用至少一次投递语义，并依赖 Codex 后续再次触发相同 `Stop`；适配器不会在后台主动重试。
- 如果 Gateway 已接受 capture，但 Hook 在写入本地成功标记前退出，后续 `Stop` 可能重新发送同一轮。重试会复用稳定消息 ID，但适配器不保证端到端恰好一次 capture。

Hook stdout 只输出 Codex 能解析的 JSON；MCP 协议消息由独立 stdio server 进程处理。

## 排查接入问题

先检查 Gateway：

```bash
curl http://127.0.0.1:8420/health
```

然后在 Codex 中检查 `/mcp` 和 `/hooks`。也可以手动运行生命周期 Hook：

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","turn_id":"turn-1","cwd":"/tmp","prompt":"记住我的回复风格"}' \
  | node /absolute/path/to/TencentDB-Agent-Memory/node_modules/tsx/dist/cli.mjs \
      /absolute/path/to/TencentDB-Agent-Memory/src/adapters/codex/cli.ts
```

没有匹配记忆时返回 `{}`；召回成功时，返回内容包含 `hookSpecificOutput.additionalContext`。

MCP adapter 的工具和运行方式请查看 [MCP adapter 指南](mcp_CN.md)。