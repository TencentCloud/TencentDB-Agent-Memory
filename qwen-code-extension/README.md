# TencentDB Agent Memory for Qwen Code

This Qwen Code extension wires Qwen lifecycle hooks to the TencentDB Agent Memory Gateway.

## Flow

| Qwen Code hook | Gateway call | Purpose |
| --- | --- | --- |
| `SessionStart` | `GET /health` | Detect Gateway availability without blocking Qwen Code. |
| `UserPromptSubmit` | `POST /recall` | Inject relevant memory as `additionalContext`. |
| `Stop` | `POST /capture` | Capture the latest completed user/assistant turn from the transcript. |
| `SessionEnd` | `POST /session/end` | Flush buffered work for the Qwen session. |

All hook failures are fail-open: Qwen Code continues even when the Gateway is offline, slow, unauthenticated, or returns malformed JSON.

## Local Setup

Start the TencentDB Agent Memory Gateway:

```bash
npx tsx src/gateway/server.ts
```

Link this extension from the repository root:

```bash
qwen extensions link ./qwen-code-extension
```

Restart Qwen Code. The hook command reads Qwen's JSON hook payload from stdin and talks to `http://127.0.0.1:8420` by default.

The extension uses a command hook wrapper:

```bash
node --import tsx ./qwen-code-extension/bin/qwen-memory-hook.mjs
```

The wrapper loads `dist/index.mjs` after a package build and falls back to the TypeScript source while developing from a linked checkout.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Full Gateway base URL. |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway host when URL is not set. |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway port when URL is not set. |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | unset | Bearer token for authenticated Gateway deployments. |
| `MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS` | `3000` | HTTP timeout for Gateway calls. |
| `MEMORY_TENCENTDB_SESSION_KEY` | derived | Explicit session key override. |
| `MEMORY_TENCENTDB_USER_ID` | unset | Optional user identifier sent to the Gateway. |
| `TDAI_QWEN_ADAPTER_STATE_DIR` | `~/.memory-tencentdb/qwen-code-adapter` | Local dedupe state directory for `Stop` captures. |

`TDAI_GATEWAY_*`, `TDAI_SESSION_KEY`, and `TDAI_USER_ID` aliases are also accepted.
