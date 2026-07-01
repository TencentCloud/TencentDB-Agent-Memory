# Codex Adapter

This directory provides the Codex adapter for `memory-tencentdb`.

The adapter does not introduce a public SDK layer. It maps Codex MCP and hook extension points to the existing memory Gateway.

## Capabilities

- Explicit memory search tools exposed over MCP:
  - `memory_tencentdb_memory_search`
  - `memory_tencentdb_conversation_search`
- `UserPromptSubmit` performs pre-prompt recall, stores the submitted prompt in a local hook cache, and emits `additionalContext` for the agent turn.
- `Stop` performs automatic capture when the hook payload, transcript, or cache contains enough data to reconstruct a complete user/assistant turn.
- If a complete turn cannot be reconstructed, the hook bridge falls back to `/session/end` and stays non-blocking.

## Files

- `config.toml.example`: Codex MCP config example.
- `.mcp.json`: optional plugin-bundled MCP config example.
- `hooks/hooks.json`: Codex hook config example.
- `.codex-plugin/plugin.json`: optional Codex plugin packaging metadata.
- `../../src/integrations/shared/mcp-server.ts`: shared MCP-to-Gateway bridge.
- `../../src/integrations/shared/hook-bridge.ts`: shared hook-to-Gateway bridge.
- `../../src/integrations/shared/gateway-client.ts`: shared HTTP client helpers for the Gateway contract.
- `../../bin/memory-tencentdb-mcp.mjs` and `../../bin/memory-tencentdb-hook.mjs`: thin Node wrappers for the TypeScript implementation or built `dist/` output.

## Setup

1. Start the memory Gateway.

```bash
memory-tencentdb-gateway
```

When developing from this repository, running the source server also works.

```bash
pnpm exec tsx src/gateway/server.ts
```

2. Make the adapter binaries available.

Install the package globally, link it during local development, or point config commands directly at the scripts in this repository.

```bash
pnpm link --global
```

3. Add the Codex MCP server.

Copy `config.toml.example` into a trusted project `.codex/config.toml`, or merge its `mcp_servers.memory-tencentdb` entry into `~/.codex/config.toml`.

4. Add hooks.

Copy `hooks/hooks.json` into the trusted Codex hook layer, or package this directory as a Codex plugin.

5. Configure the Gateway location if needed.

```bash
export MEMORY_TENCENTDB_GATEWAY_URL="http://127.0.0.1:8420"
export MEMORY_TENCENTDB_HOOK_PLATFORM="codex"
```

## Notes

Complete turn capture depends on the platform exposing enough information across `UserPromptSubmit`, `Stop`, and any transcript path in the hook payload.

The shared hook bridge stores the prompt from `UserPromptSubmit` and later pairs it with the final assistant message or transcript data. If the final assistant message is unavailable, it flushes the session instead of writing a partial turn.

`Stop` hooks must emit JSON or no stdout on success. The shared hook bridge emits structured JSON only during recall and remains silent for successful capture or flush operations.

By default, recall includes L0 conversation fallback only within the current session key. Cross-session L0 fallback can be enabled explicitly with `MEMORY_TENCENTDB_GLOBAL_L0_FALLBACK=1`.
