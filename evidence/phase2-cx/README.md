# Phase 2 — Codex 实测证据

> 对应 `SUMMARY.md` 第一章「阶段 2」用例 CX-1~CX-5

## 文件清单

| 文件 | sessionKey | 行数 | 说明 |
|---|---|---|---|
| `conversations-codex.jsonl` | `D:/GK/Project/NEKO/TencentDB-Agent-Memory::2026-07-04` | 6 | Codex CLI 通过 MCP 工具调用的 3 轮对话 |

## sessionKey 形态说明

**`D:/GK/Project/NEKO/TencentDB-Agent-Memory::2026-07-04`** 是 Codex 走 `resolveSessionKey` 回退路径生成的：
- Codex 不像 Claude Code 会传 `session_id`，stdin 里没有 session 标识
- `resolveContext` 回退到 `<cwd>::<YYYY-MM-DD>` 格式
- 这正是 CC adapter 设计的兜底语义，证明回退路径在真实 Codex 下工作

## 覆盖用例

| 用例 | 内容 | 证据来源 |
|---|---|---|
| CX-1 | Codex MCP 列表出现 memory-tdai | （`~/.codex/config.toml` 配置生效，非 capture 数据）|
| CX-2 | tdai_capture "用 Codex 测试记忆" | conversations-codex.jsonl 第 5~6 行 |
| CX-3 | 同会话 search "Codex" → 1 条 | （运行时观察）|
| CX-4 | 跨会话 search "Codex 测试" → 3 条 | （运行时观察）|
| CX-5 | 无 hooks 验证 | （Gateway 日志 0 个 `[tdai-hook]`，非 capture 数据） |

## 设计验证点

- ✅ MCP server 复用：Codex 直接加载 CC adapter 的 `bin/memory-tdai-mcp.mjs`，无需为 Codex 单独实现
- ✅ sessionKey 回退：cwd::date 格式正确生成，跨日会自动切 session
- ✅ 工具调用闭环：capture → search 闭环在同一 Codex 进程内完成
