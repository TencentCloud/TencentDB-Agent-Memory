# OpenCode × TencentDB Agent Memory

OpenCode adapter that gives every agent session persistent memory backed by
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).

## Features

- On `session.idle`, the finished session is read through the official OpenCode
  SDK (`client.session.messages`) and persisted to the Memory Gateway as an L0
  conversation (`POST /v3/conversation/add`).
- A `memory_search` tool lets the agent recall structured memories
  (`POST /v3/atomic/search`) mid-session.
- Pull-based recall: the agent decides when to search, so memory context is
  never silently injected into every prompt.
- Zero dependencies: no build step, no transitive packages — the plugin is a
  single auditable ESM file that runs on any Node ≥ 18 runtime.

## Why this adapter

- **Auditable by design.** The whole adapter is one file. Capture and recall
  stay thin; extraction, embedding and retrieval stay in MemoryCore.
- **No placeholder data.** If the transcript cannot be read, capture is skipped
  with a warning instead of writing a fake message into memory.
- **Deduplicated turns.** The same completed turn is persisted only once, even
  if `session.idle` fires repeatedly.
- **Bounded failure.** Every gateway call has a timeout and retries transient
  failures once; the v3 envelope `{code, message, data}` is validated so the
  agent sees real errors instead of silent partial success.

## How it works

```text
OpenCode session
   │  session.idle
   ▼
adapter (src/index.js)
   │  client.session.messages()          (read finished transcript)
   │  POST /v3/conversation/add          (persist as L0 conversation)
   ▼
TencentDB Agent Memory Gateway ──► MemoryCore pipeline ──► retrievable memories
   ▲
   │  memory_search tool
   │  POST /v3/atomic/search
   └── agent asks "search my memories about X"
```

Two hooks cover the full loop: **capture** persists what happened, **recall**
makes it available later. Recall is agent-driven: rather than injecting context
into every message, the agent calls `memory_search` exactly when it needs facts
from earlier sessions — less prompt pollution, more predictable behavior.

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
| `OPCODE_MEMORY_API_KEY` | `local` | Gateway API key, if auth is enabled |
| `OPCODE_MEMORY_TEAM_ID` / `_AGENT_ID` / `_USER_ID` | `default` / `opencode` / `default` | Tenancy isolation |
| `OPCODE_MEMORY_TIMEOUT_MS` | `10000` | Per-request gateway timeout |

## Usage

Ask the agent to "search my memories about X" — it will call the `memory_search`
tool and answer from persistent memory. Every finished session is automatically
captured (deduplicated) for the next one.

## Development

The test suite uses only the Node built-in test runner and a local mock gateway:

```bash
node --check src/index.js
node --test
```

No dependencies to install; the adapter is plain ESM JavaScript.
