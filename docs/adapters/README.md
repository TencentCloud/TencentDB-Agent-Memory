# Cross-Platform Adapters

How the host-neutral TDAI memory engine reaches each agent platform, and how to
add the next one. Built for [issue #235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235).

| Doc | Tier | What's inside |
| :-- | :--- | :------------ |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 基础 | Core engine (`TdaiCore`) + every adapter, with recall/capture data-flow diagrams |
| [COMPARISON.md](./COMPARISON.md) | 深入 | OpenClaw vs. Hermes vs. MCP vs. Dify — trade-offs, quadrant, decision tree |
| [ADDING-A-PLATFORM.md](./ADDING-A-PLATFORM.md) | 拓展 | The ~30-line recipe on the unified adapter SDK |

## What shipped

- **Unified adapter SDK** — [`src/sdk`](../../src/sdk/README.md): `TdaiGatewayClient`
  (transport), `MemoryAdapter` / `GatewayMemoryAdapter` (the one interface),
  `buildMemoryTools()` (neutral tool descriptors).
- **MCP server adapter** — [`src/adapters/mcp`](../../src/adapters/mcp/README.md):
  one stdio server → Claude Code, Codex, Cursor, Cline, Windsurf.
- **Dify adapter** — [`src/adapters/dify`](../../src/adapters/dify/README.md):
  a declarative OpenAPI schema, zero glue code.

## Adapter map

| Platform | Style | Location | Language |
| :------- | :---- | :------- | :------- |
| OpenClaw | In-process plugin | `index.ts` | TypeScript |
| Hermes | HTTP provider | `hermes-plugin/` | Python |
| Claude Code / Codex / Cursor / Cline | MCP stdio (new) | `src/adapters/mcp/` | TypeScript |
| Dify | OpenAPI custom tool (new) | `src/adapters/dify/` | YAML |

All four share one Gateway and one memory store — see ARCHITECTURE.md.
