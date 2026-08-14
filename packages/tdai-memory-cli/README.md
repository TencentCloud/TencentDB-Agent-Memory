# TencentDB Agent Memory Hook CLI

This project is the hook-facing CLI adapter for TencentDB Agent Memory Gateway.
It is intentionally separate from the MCP server project and from Codex
workspace installation logic.
It assumes Gateway is already running and does not start, stop, supervise, or
watch the Gateway process.

Commands:

```bash
tdai-memory prefetch --query "..." --session-key "..."
tdai-memory sync-turn --user-content "..." --assistant-content "..." --session-key "..."
tdai-memory end-session --session-key "..."
tdai-memory session-start
```

Hook wrapper commands read hook event JSON from stdin and call the commands above:

```bash
tdai-memory-hook prefetch
tdai-memory-hook sync-turn
tdai-memory-hook end-session
tdai-memory-hook session-start
```

See `examples/hooks.json`, `examples/codex/hooks.json`, and
`examples/claude-code/hooks.json` for command-hook configuration templates.
Hook failures are non-blocking by default; set `TDAI_HOOK_STRICT=1` to return
non-zero on Gateway or parsing failures.
Set `TDAI_HOOK_LOG=/path/to/hooks.jsonl` to append lightweight diagnostics for
hook invocation tests. The Codex installer defaults this to
`~/.codex/tdai-memory/logs/hooks.jsonl`.

`session-start` does not write `AGENTS.md` or `CLAUDE.md`. Prompt-file updates
belong to an explicit installer/plugin step, not to runtime hooks. Other
commands send requests to the configured Gateway URL and report errors if
Gateway is unavailable.

Gateway request configuration:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420
TDAI_GATEWAY_API_KEY=
TDAI_SESSION_KEY=
TDAI_USER_ID=
TDAI_REQUEST_TIMEOUT_MS=30000
```

Run from source:

```bash
cd packages/tdai-memory-cli
python3 -m tdai_memory_cli prefetch --query "..."
```

Tests:

```bash
python3 -m pytest tests/unit -q
# Requires an already running Gateway at TDAI_GATEWAY_URL.
TDAI_MEMORY_CLI_E2E=1 python3 -m pytest tests/e2e -q
```
