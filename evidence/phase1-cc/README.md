# Phase 1 — Claude Code 实测证据

> 对应 `SUMMARY.md` 第一章「阶段 0 + 阶段 1」用例 0.1~0.3 + CC-1~CC-7

## 文件清单

| 文件 | sessionKey | 行数 | 说明 |
|---|---|---|---|
| `conversations-smoke-test.jsonl` | `smoke-test` | 2 | Phase 0 环境预检的暖启动对话（user="??? TypeScript"，assistant="???"） |
| `conversations-claude-code.jsonl` | `0cee18cb-0368-4db2-9807-867057075251` | 16 | Phase 1 Claude Code 真实会话 8 轮（CC-2 ~ CC-7 全过程） |

## sessionKey 形态说明

- **smoke-test**：手动构造的暖启动 session，验证 capture 通道畅通
- **0cee18cb-0368-4db2-9807-867057075251**：Claude Code 原生 session_id（UUID 格式），由 `UserPromptSubmit` 钩子的 `resolveContext` 从 stdin 提取

## 覆盖用例

| 用例 | 内容 | 证据来源 |
|---|---|---|
| 0.1~0.3 | 环境 / Hook 冷启动 / Gateway health | conversations-smoke-test.jsonl |
| CC-1 | /mcp 列出 memory-tdai + 3 工具 | （运行时观察，非 capture 数据）|
| CC-2 | tdai_capture "我喜欢 TypeScript" | conversations-claude-code.jsonl 第 3~4 行 |
| CC-3 | tdai_conversation_search 查 "TypeScript" → 6 条 | conversations-claude-code.jsonl 第 13~14 行 |
| CC-4 | Stop 钩子自动 capture | conversations-claude-code.jsonl 第 9~10 行（sessionKey 切到 cwd::date） |
| CC-5 | 跨会话召回 → 9 条 | conversations-claude-code.jsonl 第 21~22 行 |
| CC-6 | SessionEnd 钩子 | （Gateway 日志 flushSession:complete，非 capture 数据） |
| CC-7 | 软失败（停 Gateway） | （行为证据：Claude Code 不卡死，无 capture 数据） |

## 编码说明

`conversations-smoke-test.jsonl` 中的 `???` 是 PowerShell 控制台 UTF-8 编码问题导致的中文乱码（详见 `SUMMARY.md` 第三章），数据本身正确写入 SQLite，仅控制台显示损坏。
