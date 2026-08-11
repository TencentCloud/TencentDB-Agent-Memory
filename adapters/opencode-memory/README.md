# OpenCode × TencentDB Agent Memory

OpenCode adapter that gives every agent session persistent memory backed by
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).

## Features

- On `session.idle`, the turn transcript is written to the Memory Gateway (L0 conversation).
- A `memory_search` tool lets the agent recall structured memories (`/v3/atomic/search`) mid-session.
- Framework-agnostic: talks to the Gateway REST API directly (see
  `MemoryCore/hermes-plugin/memory/memory_tencentdb/client.py` for the contract).
- Zero dependencies: no build step, no transitive packages — the plugin is a
  single auditable file that runs on any Node ≥ 18 runtime.

## How it works

```text
OpenCode session
   │  session.idle
   ▼
adapter (src/index.js)
   │  POST /v3/conversation/add      (persist transcript as L0 conversation)
   ▼
TencentDB Agent Memory Gateway ──► MemoryCore pipeline ──► retrievable memories
   ▲
   │  memory_search tool
   │  POST /v3/atomic/search
   └── agent asks "search my memories about X"
```

Two hooks cover the full loop: **capture** persists what happened, **recall**
makes it available later. Keeping both thin means the adapter stays easy to
audit and the heavy lifting (extraction, embedding, retrieval) stays in
MemoryCore where it belongs.

## Prerequisites

- OpenCode CLI (any recent version with plugin support).
- The TencentDB Agent Memory Gateway running locally:

  ```bash
  cd deploy/global-images
  cp .env.example .env && $EDITOR .env
  ./start-all.sh
  ```

## Install

Add the plugin to your project config:

```jsonc
// opencode.json
{
  "plugin": ["./adapters/opencode-memory/src/index.js"]
}
```

Environment variables (optional):

| Variable | Default | Description |
|---|---|---|
| `OPCODE_MEMORY_GATEWAY_URL` | `http://127.0.0.1:8420` | Memory Gateway base URL |
| `OPCODE_MEMORY_API_KEY` | (none) | Gateway API key, if auth is enabled |
| `OPCODE_MEMORY_TEAM_ID` / `_AGENT_ID` / `_USER_ID` | `default` / `opencode` / `default` | Tenancy isolation |

## Usage

Ask the agent to "search my memories about X" — it will call the `memory_search`
tool and answer from persistent memory. Every finished session is automatically
captured for the next one.

## Notes

- The Gateway contract follows the v3 envelope `{code, message, data}`; non-zero
  codes are returned to the agent so failures are visible.
- Transcript capture prefers `ctx.client.session.chat`; if a turn is not yet
  flushed it falls back to event metadata so the pipeline never blocks.

## Development

```bash
node --check src/index.js
```

No dependencies to install; the adapter is plain ESM JavaScript.
