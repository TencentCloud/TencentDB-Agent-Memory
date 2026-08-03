# TencentDB Offload ContextEngine

This Hermes plugin delegates short-term context compaction to MemoryCore's
`POST /v2/offload/compact` API. It complements the `memory_tencentdb` provider;
the provider owns long-term recall and capture, while this engine owns
context-window compaction.

## Installation

From the `MemoryCore` directory:

```bash
bash scripts/install-hermes-plugin.sh
```

The installer links this directory to
`<hermes-agent>/plugins/context_engine/tencentdb_offload` and configures:

```yaml
memory:
  provider: memory_tencentdb
context:
  engine: tencentdb_offload
```

## Configuration

The engine reuses the v2 provider connection variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TDAI_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | MemoryCore Gateway URL |
| `TDAI_MEMORY_API_KEY` | `local` | Bearer token |
| `TDAI_MEMORY_SERVICE_ID` | `default` | `X-TDAI-Service-Id` value |
| `TDAI_OFFLOAD_CONTEXT_LENGTH` | `128000` | Initial context window |
| `TDAI_OFFLOAD_COMPACTION_RATIO` | `0.5` | Automatic compaction threshold |
| `TDAI_OFFLOAD_COMPACTION_TIMEOUT_SECONDS` | `30` | HTTP timeout |

Hermes updates the context length when the active model changes. The engine
uses Hermes's prompt-token count when available and sends the exact Offload V2
request fields: `session_id`, `messages`, `ratio`, `context_window`, and
`total_tokens`.

Gateway failures and malformed responses are fail-open: the original message
list is preserved so an unavailable memory service cannot corrupt the active
conversation.
