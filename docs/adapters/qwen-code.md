# Qwen Code Adapter

The Qwen Code adapter connects Qwen Code hooks to TencentDB Agent Memory through the existing HTTP Gateway. It is designed for coding-agent workflows where memory must improve continuity but must never block the host agent.

## Lifecycle Mapping

| Qwen Code event | Adapter behavior | Gateway endpoint |
| --- | --- | --- |
| `SessionStart` | Performs a lightweight Gateway health check. | `GET /health` |
| `UserPromptSubmit` | Sends the current user prompt to recall and returns Qwen `additionalContext`. | `POST /recall` |
| `Stop` | Parses the Qwen JSONL transcript, captures the latest completed turn, and deduplicates repeated stop hooks. | `POST /capture` |
| `SessionEnd` | Flushes buffered work for the session. | `POST /session/end` |

The adapter intentionally does not capture every tool event in the first version. Capturing complete user/assistant turns keeps the signal cleaner, reduces storage noise, and avoids uploading large tool outputs by default.

## Session Identity

The default session key is:

```text
qwen:<project-name>-<project-path-hash>:<session-id-hash>
```

This keeps different projects and Qwen sessions separated without exposing the full local filesystem path. Set `MEMORY_TENCENTDB_SESSION_KEY` or `TDAI_SESSION_KEY` to override it.

## Failure Policy

All hook paths fail open. Gateway errors, timeouts, invalid JSON, auth failures, transcript parsing errors, and local state issues are logged to stderr and return:

```json
{ "continue": true, "decision": "allow" }
```

This preserves Qwen Code's main workflow even when memory is unavailable.

## Installing In Qwen Code

From the repository root:

```bash
qwen extensions link ./qwen-code-extension
```

Then start the Gateway:

```bash
npx tsx src/gateway/server.ts
```

The extension uses a command hook wrapper:

```bash
node --import tsx ./qwen-code-extension/bin/qwen-memory-hook.mjs
```

Qwen writes hook input to stdin, and the adapter writes structured hook output to stdout. The wrapper loads `dist/index.mjs` after a package build and falls back to the TypeScript source while developing from a linked checkout.

## Environment

| Variable | Description |
| --- | --- |
| `MEMORY_TENCENTDB_GATEWAY_URL` / `TDAI_GATEWAY_URL` | Full Gateway base URL. |
| `MEMORY_TENCENTDB_GATEWAY_HOST` / `TDAI_GATEWAY_HOST` | Gateway host when URL is not set. |
| `MEMORY_TENCENTDB_GATEWAY_PORT` / `TDAI_GATEWAY_PORT` | Gateway port when URL is not set. |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` / `TDAI_GATEWAY_API_KEY` | Optional Bearer token. |
| `MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS` / `TDAI_GATEWAY_TIMEOUT_MS` | HTTP timeout in milliseconds. |
| `MEMORY_TENCENTDB_SESSION_KEY` / `TDAI_SESSION_KEY` | Explicit session key override. |
| `MEMORY_TENCENTDB_USER_ID` / `TDAI_USER_ID` | Optional user id sent to Gateway calls. |
| `TDAI_QWEN_ADAPTER_STATE_DIR` | Capture dedupe state directory. |
