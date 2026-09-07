# Claude Code 适配层安装与使用（进阶）

让 Claude Code 拥有 TencentDB Agent Memory 的**自动记忆读写**：
- 每次你提问前自动**召回**相关长期记忆并注入上下文；
- 每轮回答结束后自动**捕获**对话进入 L0→L1→L2→L3 流水线；
- 会话结束时**flush**；
- 通过 MCP 工具 `memory_search` / `conversation_search` 让 Claude 主动检索记忆。

全部复用与 Hermes 相同的 **HTTP Gateway（:8420）**，不改核心引擎。

## 1. 前置条件

1. **Node ≥ 22**，且可用 `npx tsx`。
2. **运行中的 Gateway**。若还没起，参考仓库 README「Hermes 2.B（无 Docker，接入已有环境）」把标准 Gateway 跑起来，或最简：
   ```bash
   cd <repo>
   TDAI_LLM_API_KEY=sk-xxx npx tsx src/gateway/server.ts
   # 健康检查
   # GET http://127.0.0.1:8420/health  → {"status":"ok"|"degraded"}
   ```

## 2. 一键安装

```bash
cd <你的 Claude Code 项目目录>
bash <repo>/adapter-sdk/bindings/claude-code/install.sh
```

脚本会（幂等地）把配置合并进当前项目：
- `.claude/settings.json` ← 三个 hooks（`UserPromptSubmit` / `Stop` / `SessionEnd`）
- `.mcp.json` ← `memory-tencentdb` MCP server

然后**重启 Claude Code**，并在提示时批准 `memory-tencentdb` MCP server。

> 想装到全局，把生成的 `hooks` 块合并到 `~/.claude/settings.json` 即可。

## 3. 手动安装（等价）

参考 `adapter-sdk/bindings/claude-code/settings.example.json` 与 `mcp.example.json`，把 `/ABS/PATH` 换成仓库绝对路径。

`.claude/settings.json`：
```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "npx tsx /ABS/PATH/adapter-sdk/bindings/claude-code/hook-cli.ts recall" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "npx tsx /ABS/PATH/adapter-sdk/bindings/claude-code/hook-cli.ts capture" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "npx tsx /ABS/PATH/adapter-sdk/bindings/claude-code/hook-cli.ts session-end" }] }]
  }
}
```

MCP：
```bash
claude mcp add memory-tencentdb -- npx tsx /ABS/PATH/adapter-sdk/bindings/claude-code/mcp-server.ts
```

## 4. 工作原理

| Claude Code 事件 | hook 命令 | 归一化操作 | Gateway |
| :-- | :-- | :-- | :-- |
| `UserPromptSubmit` | `hook-cli.ts recall` | 用 `prompt`+`session_id` 召回，输出 `additionalContext` 注入 | `POST /recall` |
| `Stop` | `hook-cli.ts capture` | 读 `transcript_path` 取最后一轮 user/assistant | `POST /capture` |
| `SessionEnd` | `hook-cli.ts session-end` | 用 `session_id` flush | `POST /session/end` |
| MCP `tools/call` | `mcp-server.ts` | `memory_search` / `conversation_search` | `POST /search/*` |

- 会话标识：直接用 Claude Code 的 `session_id` 作为 `session_key`。
- 捕获内容来源：`Stop` 事件不含正文，适配层解析 transcript JSONL 反推最后一轮（`ClaudeCodeBinding.readLastTurn`）。

## 5. 配置

见 `docs/adapters/adapter-sdk.md` 的环境变量表。常用：
```bash
export MEMORY_TENCENTDB_GATEWAY_PORT=8420
export MEMORY_TENCENTDB_GATEWAY_API_KEY=<与 Gateway 一致>   # 若 Gateway 开了鉴权
export MEMORY_TENCENTDB_DEBUG=1                             # 排查时看 stderr 日志
```
MCP 的 env 写在 `.mcp.json` 的 `mcpServers.memory-tencentdb.env`。

## 6. 验证

- 健康：访问 `http://127.0.0.1:8420/health`。
- Hook 手动冒烟：
  ```bash
  echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"hi"}' \
    | MEMORY_TENCENTDB_DEBUG=1 npx tsx adapter-sdk/bindings/claude-code/hook-cli.ts recall
  ```
  应输出含 `additionalContext` 的 JSON（有召回结果时）。
- MCP 手动冒烟：向 `mcp-server.ts` 逐行发送 `initialize` / `tools/list` / `tools/call` JSON-RPC。

## 7. 设计保证

- **绝不打断宿主**：`hook-cli.ts` 任何异常都 `exit(0)`；`MemoryAdapter` 吞掉所有 Gateway 错误返回 `null`。
- **零运行时依赖**：仅用 Node 内置 `fetch` / `fs` / `readline`；MCP server 手写 stdio JSON-RPC，无需 `@modelcontextprotocol/sdk`。
- **短命进程隔离**：每个 hook 用完即退，无需熔断/看门狗。

## 8. 故障排查

| 现象 | 排查 |
| :-- | :-- |
| 无召回注入 | Gateway 是否 `ok`；`session_id` 是否稳定；`MEMORY_TENCENTDB_DEBUG=1` 看日志 |
| 捕获为空 | transcript 是否存在最后一轮；`Stop` 是否带 `transcript_path` |
| MCP 工具不出现 | 是否批准了 MCP server；`.mcp.json` 路径是否绝对；重启 Claude Code |
| 401 | Gateway 开了 `TDAI_GATEWAY_API_KEY`，需设置相同的 `MEMORY_TENCENTDB_GATEWAY_API_KEY` |
