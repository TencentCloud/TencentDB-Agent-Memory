# TencentDB Agent Memory — MiMo Code Adapter

This local plugin gives
[Xiaomi MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) automatic,
cross-session memory through the existing TencentDB Agent Memory Gateway.
It uses MiMo Code's lifecycle hooks and has no runtime dependencies.

## Lifecycle mapping

```text
chat.message                         -> POST /recall
experimental.chat.system.transform  -> inject recalled context into the LLM request
session.post (main agent)            -> POST /capture for completed runs
session.deleted                      -> POST /session/end
```

Recall is automatic; the model does not need to remember to call an MCP tool.
Recalled text is projected into the system prompt and is not written into the
MiMo Code transcript. `session.post` supplies the original trajectory and final
answer for capture.

All Gateway requests are best-effort. If the Gateway is unavailable, slow, or
returns an error, MiMo Code continues the run without memory.

## Requirements

- MiMo Code 0.1.9 or newer
- A running TencentDB Agent Memory Gateway

The adapter targets MiMo Code's TUI/server plugin runtime. MiMo Code currently
documents the TUI as its supported primary interface, so this adapter does not
claim separate Web or App coverage.

## Start the Gateway

From the TencentDB Agent Memory repository root:

```bash
TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
TDAI_LLM_API_KEY="..." \
TDAI_LLM_MODEL="deepseek-chat" \
node --import tsx/esm src/gateway/server.ts
```

## Install

For the current project:

```bash
mkdir -p .mimocode/plugins
cp mimo-adapter/tdai-memory.ts .mimocode/plugins/tdai-memory.ts
```

For every project:

```bash
mkdir -p ~/.config/mimocode/plugins
cp mimo-adapter/tdai-memory.ts ~/.config/mimocode/plugins/tdai-memory.ts
```

MiMo Code discovers `plugin/*.ts` and `plugins/*.ts` files at startup. The
adapter default-exports a versioned MiMo plugin module with the stable id
`tencentdb-agent-memory`.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY`, then unset | Bearer token |
| `MEMORY_TENCENTDB_TIMEOUT_MS` | `5000` | Per-request timeout |
| `MEMORY_TENCENTDB_DEBUG` | unset | Set to `1` for warning-level diagnostics |

Session identity is stable across restarts because the adapter derives
`session_key` as `mimo_<MiMo session id>`.

## Interaction with MiMo Code memory

MiMo Code has its own local memory and consolidation features. This adapter does
not replace or modify them. TencentDB Agent Memory adds a separate L0-to-L3
pipeline and a shared Gateway identity, allowing memories captured by other
hosts such as Pi or Cline to be recalled in MiMo Code.

Because recall injection is transient rather than stored in the MiMo
transcript, the adapter intentionally does not request Gateway `dedup`. A later
turn still needs its recalled context projected into that turn's model request.

## Failure and privacy behavior

- Recall failure: inject nothing and continue.
- Capture failure: drop that capture and continue.
- Session-end failure: leave normal Gateway scheduling in place and continue.
- Only non-synthetic user text and the final assistant answer are captured.
- Tool output, reasoning, system prompts, API keys, and full hook payloads are
  not sent to the Gateway or written to debug logs.

MiMo Code does not expose a general process-shutdown hook. `/session/end` is
therefore sent when a session is deleted; ordinary `/capture` calls still notify
the Gateway scheduler after every completed turn.
