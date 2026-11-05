# Claude Code Adapter

This directory provides the Claude Code adapter for `memory-tencentdb`.

The adapter connects Claude Code MCP and hook extension points to the existing memory Gateway without introducing a public SDK abstraction.

## Capabilities

- Explicit memory search tools exposed over MCP:
  - `memory_tencentdb_memory_search`
  - `memory_tencentdb_conversation_search`
- `UserPromptSubmit` performs pre-prompt recall, stores the submitted prompt in a local hook cache, and emits `additionalContext` for the agent turn.
- `Stop` performs automatic capture when the hook payload, transcript, or cache contains enough data to reconstruct a complete user/assistant turn.
- If a complete turn cannot be reconstructed, the hook bridge falls back to `/session/end` and stays non-blocking.

## Files

- `.mcp.json`: Claude Code MCP server example.
- `.claude/settings.json`: Claude Code hook config example.
- `../../src/integrations/shared/mcp-server.ts`: shared MCP-to-Gateway bridge.
- `../../src/integrations/shared/hook-bridge.ts`: shared hook-to-Gateway bridge.
- `../../src/integrations/shared/gateway-client.ts`: shared HTTP client helpers for the Gateway contract.
- `../../bin/memory-tencentdb-mcp.mjs` and `../../bin/memory-tencentdb-hook.mjs`: thin Node wrappers for the TypeScript implementation or built `dist/` output.

## Setup

1. Start the memory Gateway.

Use the existing Gateway startup method documented in the repository README. From a source checkout:

```bash
pnpm exec tsx src/gateway/server.ts
```

2. Make the adapter binaries available.

Install the package globally, link it during local development, or point config commands directly at the scripts in this repository.

```bash
pnpm link --global
```

3. Configure MCP.

Copy `.mcp.json` into the Claude Code project root, or merge its `mcpServers.memory-tencentdb` entry into an existing MCP config.

4. Configure hooks at one scope only.

Copy `.claude/settings.json` into the Claude Code project root, or merge the `hooks` section into an existing settings file. Do not register the same hooks again in user settings; duplicate registration can inject recalled context twice.

5. Configure the Gateway location if needed.

```bash
export MEMORY_TENCENTDB_GATEWAY_URL="http://127.0.0.1:8420"
export MEMORY_TENCENTDB_HOOK_PLATFORM="claude-code"
# Optional; defaults to 10000.
export MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS="10000"
```

## Notes

The MCP path is the most stable integration surface because it uses explicit tool calls.

Complete turn capture depends on the platform exposing enough information across `UserPromptSubmit`, `Stop`, and any transcript path in the hook payload.

The shared hook bridge stores the prompt from `UserPromptSubmit` and later pairs it with the final assistant message or transcript data. If the final assistant message is unavailable, it flushes the session instead of writing a partial turn.

By default, recall includes L0 conversation fallback only within the current session key. Cross-session L0 fallback can be enabled explicitly with `MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK=1`.

The hook cache is private local state under the OS temporary directory. Set `MEMORY_TENCENTDB_HOOK_CACHE_DIR` only when a persistent custom location is required. Capture claims make repeated `Stop` delivery idempotent for the same turn.

Gateway failures are reported to stderr (and to `MEMORY_TENCENTDB_HOOK_AUDIT_LOG` when configured) but never fail the Claude Code turn.
