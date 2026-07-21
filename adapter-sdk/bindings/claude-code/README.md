# Claude Code 绑定

让 Claude Code 自动读写 TencentDB Agent Memory。安装与使用见完整指南：
[`../../../docs/adapters/claude-code.md`](../../../docs/adapters/claude-code.md)

## 文件

| 文件 | 作用 |
| :-- | :-- |
| `binding.ts` | 实现 `PlatformBinding`：解析 hook JSON + transcript，格式化 `additionalContext` |
| `hook-cli.ts` | Claude Code hooks 的统一入口：`recall` / `capture` / `session-end` |
| `mcp-server.ts` | 无依赖 MCP stdio 服务，暴露 `memory_search` / `conversation_search` |
| `install.sh` | 幂等地把 hooks 写入 `.claude/settings.json`、MCP 写入 `.mcp.json` |
| `settings.example.json` / `mcp.example.json` | 手动配置示例 |

## 一键安装

```bash
cd <你的 Claude Code 项目>
bash <repo>/adapter-sdk/bindings/claude-code/install.sh
```

前置：运行中的 Gateway（:8420）、Node ≥ 22、`npx tsx`。
