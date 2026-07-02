# TencentDB Offload ContextEngine (Hermes)

Standalone Hermes `ContextEngine` adapter for TencentDB short-term context
offload. It complements the existing `memory_tencentdb` long-term memory
provider; it does not replace it.

## Behavior

- `should_compress()` triggers when prompt tokens cross
  `TENCENTDB_OFFLOAD_THRESHOLD_RATIO * context_length`.
- `compress()` posts to `POST /v2/offload/compact`.
- `update_from_response()` sends response data to `POST /v2/offload/ingest`
  on a daemon thread.
- If the remote service is unavailable or returns an unexpected shape,
  `compress()` keeps system messages plus the recent message tail and inserts a
  valid system notice, so Hermes sessions do not deadlock.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TENCENTDB_OFFLOAD_GATEWAY_URL` | `http://127.0.0.1:8420` | HTTP base URL for the offload service |
| `TENCENTDB_OFFLOAD_API_KEY` | unset | Optional Bearer token |
| `TENCENTDB_OFFLOAD_THRESHOLD_RATIO` | `0.4` | Compression threshold ratio |
| `TENCENTDB_OFFLOAD_TIMEOUT_SECS` | `10` | Remote request timeout |
| `TENCENTDB_OFFLOAD_CONTEXT_LENGTH` | `200000` | Fallback context window for threshold checks |
| `TENCENTDB_OFFLOAD_FALLBACK_KEEP` | `12` | Recent non-system messages kept by fallback |

## Expected Remote Contract

`POST /v2/offload/compact` receives:

```json
{
  "messages": [],
  "session_key": "optional-session",
  "context_length": 200000,
  "target_tokens": null
}
```

It should return one of:

```json
{ "messages": [] }
```

or:

```json
{ "compacted_messages": [] }
```

`POST /v2/offload/ingest` receives the Hermes response payload and optional
session metadata. Ingest is best-effort and non-blocking from Hermes's user
path.
