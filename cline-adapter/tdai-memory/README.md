# TencentDB Agent Memory — Cline Adapter

This plugin gives [Cline CLI](https://github.com/cline/cline) automatic,
cross-session memory through the existing TencentDB Agent Memory Gateway. It
uses Cline's in-process Plugin API and has no runtime dependencies.

## Lifecycle mapping

```text
beforeRun   -> POST /recall
beforeModel -> project recalled context into the provider request
afterRun    -> POST /capture for completed runs
```

All Gateway calls are best-effort. If the Gateway is unavailable or times out,
Cline continues without memory; the hook never cancels a task.

## Requirements

- Node.js 22 or newer
- Cline CLI 3.0.46 or newer
- A running TencentDB Agent Memory Gateway

## Start the Gateway

From the repository root:

```bash
TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
TDAI_LLM_API_KEY="..." \
TDAI_LLM_MODEL="deepseek-chat" \
node --import tsx/esm src/gateway/server.ts
```

## Install

Install the adapter directory as a project-scoped Cline plugin:

```bash
cline plugin install ./cline-adapter/tdai-memory --cwd .
```

The plugin automatically recalls before each run and captures successful runs.
It does not depend on the model remembering to call a memory tool.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY`, then unset | Bearer token for Gateway auth |
| `MEMORY_TENCENTDB_TIMEOUT_MS` | `5000` | Per-request timeout |
| `MEMORY_TENCENTDB_DEBUG` | unset | Set to `1` for error diagnostics on stderr |

The adapter derives `session_key` as `cline_<conversationId>`.

## Failure behavior

- Recall failure: inject nothing and continue the task.
- Capture failure: drop that capture and continue.
- Debug logging never prints API keys or full hook payloads.

## Scope

This adapter targets Cline CLI's Plugin API. Current Cline file hooks run prompt
hooks asynchronously in CLI hosts, and the current VS Code SDK adapter does not
project `contextModification` from `UserPromptSubmit` into model requests.
Because neither path can guarantee automatic recall injection, IDE file-hook
support is intentionally not claimed here.

Cline's Plugin API does not currently expose a uniform session-shutdown hook, so
the adapter does not call `/session/end`. Calling it after every completed run
would reset session-level recall deduplication on every turn.

Recall requests intentionally do not set Gateway `dedup: true`. The Plugin API's
`beforeModel` projection is ephemeral and is not saved in Cline's transcript, so
deduplicating a later run would remove context that is no longer present.
