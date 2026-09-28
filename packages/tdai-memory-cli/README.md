# TencentDB Agent Memory Hook CLI

This project is the hook-facing CLI adapter for TencentDB Agent Memory Gateway.
It is intentionally separate from the MCP server project and from Codex
workspace installation logic.

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

See `examples/hooks.json` for a command-hook configuration example. Hook failures
are non-blocking by default; set `TDAI_HOOK_STRICT=1` to return non-zero on
Gateway or parsing failures.
Set `TDAI_HOOK_LOG=/path/to/hooks.jsonl` to append lightweight diagnostics for
hook invocation tests. The Codex installer defaults this to
`~/.codex/tdai-memory/logs/hooks.jsonl`.

`session-start` checks Gateway health and optionally starts Gateway when
`TDAI_GATEWAY_AUTO_START=1`. Hook-started Gateway stdout/stderr is written to
`TDAI_GATEWAY_LOG_DIR/gateway.log`, and a detached watchdog records pid and
heartbeat state in `TDAI_GATEWAY_RUNTIME_DIR`. The watchdog stops only the
Gateway process recorded by this adapter after `TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS`
of hook/CLI inactivity; set that value to `0` to disable idle shutdown.

`session-start` does not write `AGENTS.md`; Codex user prompt setup belongs to
the repository install script. Other commands also ensure Gateway is reachable
before sending their request, so a Gateway stopped by the idle watchdog can be
started again on the next hook.

Gateway request configuration:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420
TDAI_GATEWAY_API_KEY=
TDAI_SESSION_KEY=
TDAI_USER_ID=
TDAI_REQUEST_TIMEOUT_MS=30000
TDAI_GATEWAY_AUTO_START=1
TDAI_GATEWAY_CONFIG=/Users/bytedance/.codex/tdai-memory/tdai-gateway.yaml
TDAI_DATA_DIR=/Users/bytedance/.codex/tdai-memory/data
TDAI_GATEWAY_CWD=/Users/bytedance/proj/TencentDB-Agent-Memory
TDAI_GATEWAY_CMD=
TDAI_GATEWAY_STARTUP_TIMEOUT_MS=30000
TDAI_GATEWAY_HEALTH_POLL_MS=500
TDAI_GATEWAY_RUNTIME_DIR=/Users/bytedance/.codex/tdai-memory/runtime
TDAI_GATEWAY_LOG_DIR=/Users/bytedance/.codex/tdai-memory/logs
TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS=600
TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS=30
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
