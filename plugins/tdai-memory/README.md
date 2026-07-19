# TencentDB Agent Memory Codex Plugin

This is the Codex-facing integration layer for TencentDB Agent Memory.

It intentionally contains only plugin metadata, MCP declaration, hook examples,
and skills. The reusable adapter code lives in:

- `../../packages/tdai-memory-mcp`
- `../../packages/tdai-memory-cli`

Use the repository install script to install shared packages, register the
Codex plugin, install bundled plugin hooks, and create/update `AGENTS.md` under
`~/.codex`:

```bash
../../scripts/install-codex.sh
```

The install script is idempotent:

- editable-installs `../../packages/tdai-memory-mcp`
- editable-installs `../../packages/tdai-memory-cli`
- runs `codex plugin marketplace add`
- runs `codex plugin add tdai-memory@tdai-memory-local`
- registers the `tdai-memory` MCP server with `codex mcp add`
- creates or updates `~/.codex/AGENTS.md`
- writes bundled plugin hooks to `hooks/hooks.json` before plugin installation
- removes legacy tdai-memory entries from `~/.codex/hooks.json`
- configures MCP tool approval policy in `~/.codex/config.toml`
- writes the default Gateway config to `~/.codex/tdai-memory/tdai-gateway.yaml`
- stores memory data under `~/.codex/tdai-memory/data/`
- stores hook diagnostics under `~/.codex/tdai-memory/logs/hooks.jsonl`
- stores Gateway pid/heartbeat files under `~/.codex/tdai-memory/runtime/`
- stores Gateway/watchdog logs under `~/.codex/tdai-memory/logs/`

`AGENTS.md` setup is intentionally handled only at install time. Runtime hook
commands do not create, rewrite, or dynamically inject `AGENTS.md` content.
Pass `--agents-path /path/to/AGENTS.md` only when you explicitly want a
different target.

The installer configures hooks and MCP to auto-start Gateway by default. The
generated Gateway config uses local Ollama models `gemma4:latest` and
`bge-m3:latest`.

Hook-started Gateway processes are detached from Codex and are stopped by a
side-channel watchdog after 600 seconds of hook/CLI inactivity by default. Use
`scripts/install-codex.sh --gateway-idle-timeout 0` to disable this, or pass a
different timeout value to tune it.

Codex plugin-bundled hooks require manual trust review after installation.
Open `/hooks` in Codex, review the three TDAI hook commands, and trust them
before expecting automatic prefetch/capture to run. `examples/hooks.json` is
retained only as a manual/debugging reference for older Codex builds or
non-plugin setups.

The installer sets `default_tools_approval_mode = "auto"` for the tdai-memory
MCP server and explicitly approves the two read-only lookup tools:
`tdai_memory_search` and `tdai_conversation_search`.
