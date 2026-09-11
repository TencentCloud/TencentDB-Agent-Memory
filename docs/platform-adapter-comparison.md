# 平台适配对比：Codex、Claude Code 和 OpenCode / Platform Adapter Comparison

## 范围 / Scope

本实现为 issue #235 先落地三个真实平台适配，再从实际差异中判断是否值得抽象公共 SDK。
For issue #235, this implementation validates three concrete adapters before deciding whether a public SDK is justified.

- Codex：MCP + command hooks
- Claude Code: MCP + command hooks
- OpenCode: MCP + project plugin

这次改动不修改 `TdaiCore` 或 Gateway 路由，也不导出新的公共 SDK。唯一的 Gateway contract 扩展是 `/capture` 的可选 `started_at` 字段，用于保证外部 adapter 的首个 turn 不会被冷启动游标过滤。
This change does not modify `TdaiCore` or Gateway routes and exports no new public SDK. Its only Gateway contract extension is optional `/capture.started_at`, which keeps an external adapter's first turn from being filtered by the cold-start cursor.

## 复用的现有边界 / Existing Boundary Reused

| 能力 / Capability | Existing Gateway endpoint | Adapter use |
| --- | --- | --- |
| prompt 前 recall / pre-prompt recall | `POST /recall` | inject relevant structured memory |
| L0 fallback | `POST /search/conversations` | search the current session; global search is opt-in |
| turn 后 capture / post-turn capture | `POST /capture` | persist a complete user/assistant turn |
| structured search | `POST /search/memories` | MCP tool |
| raw conversation search | `POST /search/conversations` | MCP tool |
| session flush | `POST /session/end` | flush when a complete turn cannot be reconstructed |

The shared files are implementation details inside this package:

- `src/integrations/shared/gateway-client.ts`: bounded HTTP transport for hooks and MCP
- `src/integrations/shared/hook-bridge.ts`: Codex/Claude Code lifecycle mapping
- `src/integrations/shared/mcp-server.ts`: read-only memory search tools

`integrations/opencode/plugin.js` keeps a small self-contained transport because users copy that file into `.opencode/plugins/`.

## 平台差异 / Platform Differences

| Dimension | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| MCP config | `config.toml` or plugin `.mcp.json` | project `.mcp.json` | `opencode.json` |
| Lifecycle config | `hooks.json` or Codex plugin | `.claude/settings.json` | `.opencode/plugins/memory-tencentdb.js` |
| Before prompt | `UserPromptSubmit.prompt` | `UserPromptSubmit.prompt` | `chat.message` text parts |
| After turn | `Stop.last_assistant_message` or transcript | `Stop.last_assistant_message` or transcript | completed assistant message + text parts |
| Session identity | platform id, then cwd fallback | platform id, then cwd fallback | workspace root + OpenCode session id |
| Stable capability | MCP search tools | MCP search tools | MCP search tools |
| Automatic behavior | best effort | best effort | best effort |

共同点：MCP 是稳定的显式搜索面；自动 recall/capture 取决于宿主是否提供完整生命周期 payload。
Common ground: MCP is the stable explicit search surface. Automatic recall and capture depend on complete lifecycle payloads from the host.

### Codex

- `UserPromptSubmit` caches the prompt and emits `additionalContext`.
- `Stop` pairs the cached prompt with `last_assistant_message` or transcript content.
- `.codex-plugin/plugin.json` packages the MCP and hook configuration without platform-private APIs.

### Claude Code

- Uses the same hook bridge and MCP server as Codex.
- Only the project configuration shape differs: `.claude/settings.json` plus `.mcp.json`.
- Existing settings must be merged instead of overwritten.

### OpenCode

- `chat.message` injects a synthetic `<relevant-memories>` text part.
- `message.part.updated` is treated as a full-part replacement, so streaming prefixes are not duplicated in captured memory.
- `session.error` flushes the session and never captures partial assistant output.

## 可靠性边界 / Reliability Boundary

- Gateway requests default to a 10-second timeout. Override with `MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS`.
- Hook failures exit without blocking the host agent; optional audit logs record hashed session identifiers.
- Hook capture is idempotent for the same platform/session/turn, including accidental duplicate hook registration.
- Prompt caches are written under the OS temporary directory with private file permissions. Override with `MEMORY_TENCENTDB_HOOK_CACHE_DIR`.
- L0 fallback is session-scoped by default. `MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK=1` explicitly enables cross-session fallback; `MEMORY_TENCENTDB_DISABLE_L0_RECALL=1` disables L0 fallback.
- MCP Gateway failures are returned as tool errors, not JSON-RPC protocol failures.
- If a complete turn cannot be reconstructed, the adapter calls `/session/end` rather than persisting partial memory.
- Capture sends canonical user/assistant messages plus `started_at` immediately before their adapter-assigned timestamp. This keeps the first external turn ahead of the Gateway's cold-start capture cursor without changing memory-core behavior.

Configure hooks at either project scope or user scope, not both. Capture deduplication protects stored data, but a single registration also avoids duplicate recall requests and duplicate context injection.

## 为什么暂不做 SDK / Why No SDK Yet

The three hosts agree on five low-level needs:

1. stable session identity;
2. pre-prompt recall;
3. post-turn capture;
4. explicit search tools;
5. session flush semantics.

They do not yet agree on event names, payload completeness, configuration packaging, or assistant-stream assembly. A public SDK now would freeze those host-specific assumptions too early. The current internal bridge keeps the contract narrow and lets future SDK work start from behavior proven on real hosts.

## 已知限制 / Known Limitations

- Automatic capture cannot recover content the host never exposes.
- Transcript formats may evolve; unknown transcript records are ignored rather than guessed.
- Hooks are non-blocking by design, so a Gateway outage is visible in stderr/audit logs but does not stop the coding agent.
- The adapters require an already-running memory-tencentdb Gateway; they do not add a second Gateway startup path.
