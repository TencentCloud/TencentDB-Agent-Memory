# Compare Codex, Claude Code, and OpenCode integrations

TencentDB Agent Memory uses the same Gateway and shared stdio MCP server across Codex, Claude Code, and OpenCode. The integration differs in the platform lifecycle surface: Codex and Claude Code use command hooks, while OpenCode also has a native plugin.

All three lifecycle integrations implement the public `PlatformAdapter` contract. Platform-specific code extracts native events and message shapes, while the shared runtime provides Gateway access, fail-open behavior, operation deduplication, and shutdown coordination. See [Add a platform with the Adapter SDK](adapter-sdk.md) to build another integration.

Use this guide to choose an integration model. For installation commands and platform-specific troubleshooting, use the linked integration guides.

| Area                              | Codex                                           | Claude Code                                                | OpenCode                                               |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Automatic lifecycle mechanism     | Command hooks                                   | Command hooks                                              | Native plugin                                          |
| Shared MCP server                 | Yes                                             | Yes                                                        | Yes                                                    |
| Automatic recall                  | `UserPromptSubmit`                              | `UserPromptSubmit`                                         | `chat.message`, then system-context injection          |
| Automatic capture                 | `Stop`                                          | `Stop` when no background tasks or scheduled wakeups exist | `session.status` with `idle`, or legacy `session.idle` |
| Automatic session flush           | Not available: Codex has no `SessionEnd` hook   | `SessionEnd`                                               | `session.deleted`                                      |
| Context injection                 | Hook `additionalContext`                        | Hook `additionalContext`                                   | `experimental.chat.system.transform`                   |
| Distribution model                | Repository checkout with installed dependencies | Repository checkout with installed dependencies            | Published npm package for the plugin and MCP command   |
| Platform-specific state directory | `~/.memory-tencentdb/codex-adapter`             | `~/.memory-tencentdb/claude-code-adapter`                  | `~/.memory-tencentdb/opencode-adapter`                 |

## What all three platforms share

All integrations connect to the same Gateway, which listens on `http://127.0.0.1:8420` by default. The shared MCP server exposes the same model-callable tools:

- `tdai_memory_recall`
- `tdai_memory_capture`
- `tdai_session_end`
- `tdai_memory_search`
- `tdai_conversation_search`

Automatic recall and capture are deterministic lifecycle actions. They do not depend on the model deciding to call an MCP tool. The search tools remain available when the model needs more historical detail.

Each adapter accepts `TDAI_GATEWAY_URL` and `TDAI_GATEWAY_API_KEY`. One Gateway instance currently represents one memory namespace; these variables do not provide user-level namespace isolation. Capture uses at-least-once delivery. A stable message ID lets downstream storage deduplicate a retry if the Gateway accepts a capture before the local success marker is written.

## Choose Codex for a minimal Hook-based setup

Codex uses `UserPromptSubmit` to recall memory and `Stop` to capture the final turn. Both events run the Codex adapter through command hooks, and the adapter calls the shared Gateway HTTP client directly. The separate MCP server remains available for model-initiated tools.

Codex does not expose a `SessionEnd` hook. It therefore cannot automatically call `tdai_session_end` when a session ends. This is the main lifecycle gap compared with Claude Code and OpenCode.

Choose Codex when its native Hook and MCP configuration are already part of your development workflow, and automatic session flushing is not required.

See [the Codex integration guide](codex.md) for setup and troubleshooting.

## Choose Claude Code for Hook-based lifecycle coverage

Claude Code uses the same command-hook pattern as Codex, but includes a `SessionEnd` event. Its adapter recalls on `UserPromptSubmit`, captures on `Stop`, and flushes queued work on `SessionEnd`.

The `Stop` handler skips capture while `background_tasks` or `session_crons` are present. This avoids recording a temporary pause as a completed response. Claude Code `v2.1.196` or later is required because the adapter uses `prompt_id` to associate prompt and response state across independent Hook processes.

Choose Claude Code when you want a Hook-based integration with automatic session flushing and protection against capturing turns that are still waiting on background work.

See [the Claude Code integration guide](claude-code.md) for setup and troubleshooting.

## Choose OpenCode for native plugin lifecycle handling

OpenCode uses two complementary paths:

- A native plugin performs automatic recall, system-context injection, capture, and session flushing.
- The shared stdio MCP server exposes on-demand memory tools to the model.

The plugin injects recalled content into system context without changing the user message or transcript. When the session becomes idle, it reads the session history and captures only the newest complete user/assistant turn. It excludes reasoning, tool output, synthetic or ignored text, failed responses, and incomplete or aborted answers.

OpenCode currently uses the legacy `experimental.chat.system.transform` hook for system-context injection. The plugin supports both the current `session.status` idle event and the deprecated `session.idle` event. Record the OpenCode version in production smoke tests, since a future V2 plugin API migration needs a stable replacement for the experimental injection point.

Choose OpenCode when you need plugin-level lifecycle control, precise completed-turn selection, and system-context injection that leaves the conversation transcript unchanged.

See [the OpenCode integration guide](opencode.md) for setup and troubleshooting.

## Compare failure behavior

All three integrations are fail-open: memory failures must not block an agent turn or session shutdown. Recall failures preserve the original prompt or context, and capture failures preserve or release local state so a later lifecycle event can retry.

The retry trigger differs by platform:

| Platform    | Capture retry opportunity                            |
| ----------- | ---------------------------------------------------- |
| Codex       | A later repeated `Stop` event                        |
| Claude Code | A later repeated `Stop` event                        |
| OpenCode    | A later idle event after its local claim is released |

## Configure the right platform surface

| Platform    | Configure lifecycle automation                                     | Configure MCP                                            |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Codex       | `~/.codex/hooks.json` or `<project>/.codex/hooks.json`             | `~/.codex/config.toml` or `<project>/.codex/config.toml` |
| Claude Code | `~/.claude/settings.json` or `<project>/.claude/settings.json`     | Project `.mcp.json` or `claude mcp add`                  |
| OpenCode    | `opencode.json` or `~/.config/opencode/opencode.json` plugin entry | The `mcp` section in the same OpenCode configuration     |

For all platforms, start and verify the Gateway before debugging the client integration:

```bash
curl http://127.0.0.1:8420/health
```

Then use the platform-specific verification command: `/mcp` and `/hooks` in Codex or Claude Code, or `opencode mcp list` in OpenCode.

## Read the detailed setup guides

- [Codex](codex.md)
- [Claude Code](claude-code.md)
- [OpenCode](opencode.md)
- [简体中文对比指南](platform-comparison_CN.md)
