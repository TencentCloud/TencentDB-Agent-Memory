# TencentDB Agent Memory Codex integration plugin

This plugin combines Codex lifecycle automation, model-facing guidance, and
focused MCP tools for TencentDB Agent Memory v2. Hooks and MCP reuse the
shared MemoryCore Gateway client; the plugin contains no memory store,
extraction pipeline, or second SDK/server implementation.

The original #953 rescope was too aggressive: while removing the duplicated
adapter/SDK framework discussed in #392, it also removed Codex hooks. The #392
triage asked platform-specific hooks to be split out behind the shared Gateway
boundary; it did not reject them. See [the executable redesign](./docs/design-v2.md).

## Status

The package currently lands the first reviewable redesign slice: a four-event
fail-open hook contract (`SessionStart`, `UserPromptSubmit`, `Stop`,
`SessionEnd`), shared identity/state plumbing, the focused stdio MCP adapter,
and a public-route operation registry. Read-only capability discovery is
available only when `TDAI_MCP_ENABLE_ADVANCED=true`; raw operation execution is
not implemented. Additional curated L0-L3/Skill/Knowledge typed tools remain
separately staged.

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

Hooks require explicit `TDAI_SERVICE_ID`, `TDAI_INSTANCE_ID`, `TDAI_TEAM_ID`,
`TDAI_AGENT_ID`, `TDAI_USER_ID`, and a host-provided session id. They never
invent team/user/agent fallbacks. Hook failures are fail-open so Codex remains
usable while the diagnostic is reported on stderr.

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
| Codex app / CLI | Skill, focused MCP tools, and four lifecycle hooks | This Plugin packages; shared Gateway/Core executes |
| Codex with hooks disabled | MCP and Skill continue to work | Hook automation is independent of MCP startup |
| Codex IDE extension | Documented separately; no plugin/Proxy claim here | MemoryProxy/#833 remains a separate transport route |
| ChatGPT Chat / Work | Compatible Skill/MCP only when a trusted remote MCP is registered | ChatGPT does not execute Codex lifecycle hooks |

See [Non-goals and overlap](./docs/overlap-analysis.md) and [surface compatibility](./docs/surfaces.md).
