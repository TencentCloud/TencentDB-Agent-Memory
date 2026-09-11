# TencentDB Agent Memory For Claude Code

This Claude Code plugin is a thin integration layer over the shared adapters:

- `../../packages/tdai-memory-mcp`
- `../../packages/tdai-memory-cli`

It does not copy or modify the existing Gateway, Core, Hermes provider, or
OpenClaw plugin code.

## Surfaces

- MCP tools:
  - `tdai_memory_search`: search structured long-term memories.
  - `tdai_conversation_search`: search raw conversation history.
- Hooks:
  - `SessionStart`: ensure the Gateway is running.
  - `UserPromptSubmit`: prefetch memory for the submitted prompt.
  - `Stop`: capture the completed user/assistant turn.
- `CLAUDE.md`:
  - stable static instructions that tell Claude Code when to use memory tools.

## Install

From the repository root:

```bash
scripts/install-claude-code.sh
```

The installer is idempotent. It editable-installs the shared Python packages,
writes Claude Code plugin MCP and hook config, registers the local marketplace,
installs the plugin, and creates or updates only the marked TDAI block in
`~/.claude/CLAUDE.md`.

Default runtime files are stored under `~/.claude/tdai-memory/`:

- Gateway config: `~/.claude/tdai-memory/tdai-gateway.yaml`
- Memory data: `~/.claude/tdai-memory/data/`
- Hook diagnostics: `~/.claude/tdai-memory/logs/hooks.jsonl`
- Gateway/watchdog logs: `~/.claude/tdai-memory/logs/`
- Gateway pid/heartbeat: `~/.claude/tdai-memory/runtime/`

## Notes

The plugin keeps lifecycle behavior in CLI hooks and only exposes lookup tools
through MCP. Health diagnostics remain a side channel through
`tdai-memory-mcp health`; they are not exposed to Claude Code as LLM-callable
MCP tools.
