# TencentDB Agent Memory OpenAI/Codex Plugin PoC

This is a deliberately thin packaging and distribution layer for TencentDB Agent Memory v2. It bundles instructions and a launcher for the **official** MCP executable; it contains no memory implementation.

## Status

The Plugin package is functional and validated. This branch ports the already-reviewed #603 Gateway client and stdio MCP adapter to the current v2 `MemoryCore` package, preserving its executable and tool contract rather than creating a parallel implementation.

## Install for repo-local testing

The repo marketplace is defined at `.agents/plugins/marketplace.json`. Add the repository as a local marketplace, install `tdai-memory`, and start a new session so Codex loads its Skill and MCP config.

For repository development, build the v2 MemoryCore package first. The Plugin automatically discovers `MemoryCore/dist/memory-tencentdb-mcp.mjs`:

```bash
cd MemoryCore
npm install
npm run build
```

For an installed Plugin, install the official MemoryCore package so its `memory-tencentdb-mcp` command is on `PATH`. You may also point the Plugin at an explicit packaged executable:

```bash
export TDAI_MEMORY_MCP_BIN=/absolute/path/to/memory-tencentdb-mcp
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
```

Gateway API keys are inherited from `TDAI_GATEWAY_API_KEY`; setup never writes them to disk.

## Setup and health

Preview the non-secret config:

```bash
node scripts/setup.mjs
```

Write it only when desired:

```bash
node scripts/setup.mjs --write ~/.config/tdai-memory/openai-plugin.json
```

Check the official MCP binary, MemoryCore Gateway, and optional MemoryProxy:

```bash
node scripts/health-check.mjs --json
```

Remote endpoints are rejected by default. Use `--allow-remote` only for a trusted deployment.

## Modes

| Surface | PoC behavior | Ownership |
| --- | --- | --- |
| Codex app / CLI | Skill plus official stdio MCP tools | This Plugin packages; official MCP executes |
| Codex CLI / non-Plan | Explicit tool recall/capture; no automatic injection | Official MCP/Gateway |
| Codex IDE Plan mode | Plugin unavailable in IDE | v2.0.1 MemoryProxy roadmap |
| ChatGPT Chat / Work | Skill portable; tools require registered remote MCP | Future official hosted MCP/app registration |

See [Non-goals and overlap](./docs/overlap-analysis.md) and [surface compatibility](./docs/surfaces.md).
