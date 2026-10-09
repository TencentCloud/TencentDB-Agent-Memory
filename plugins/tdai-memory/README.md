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
- stores hook diagnostics under `~/.codex/tdai-memory/logs/hooks.jsonl`

`AGENTS.md` setup is intentionally handled only at install time. Runtime hook
commands do not create, rewrite, or dynamically inject `AGENTS.md` content.
Pass `--agents-path /path/to/AGENTS.md` only when you explicitly want a
different target.

The installer does not start, configure, stop, or watch the Gateway process.
MCP lookup tools and hook commands connect to the configured Gateway URL. Start
Gateway separately before relying on prefetch or capture hooks.

Codex plugin-bundled hooks require manual trust review after installation.
Open `/hooks` in Codex, review the three TDAI hook commands, and trust them
before expecting automatic prefetch/capture to run. `examples/hooks.json` is
retained only as a manual/debugging reference for older Codex builds or
non-plugin setups.

The installer sets `default_tools_approval_mode = "auto"` for the tdai-memory
MCP server and explicitly approves the two read-only lookup tools:
`tdai_memory_search` and `tdai_conversation_search`.
