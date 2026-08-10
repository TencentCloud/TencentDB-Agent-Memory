# TencentDB Agent Memory for OpenCode

This adapter connects OpenCode to TencentDB Agent Memory v3 without patching OpenCode. It recalls
relevant long-term memory before each model request and captures completed user/assistant turns when
an OpenCode session becomes idle.

> Status: initial community adapter for [issue #926](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926).
> The package is under active review and is not published to npm yet.

## Features

- Recalls L1 atomic memories and L3 core memory for each user message.
- Injects bounded recall into the system context and explicitly marks it as untrusted data.
- Captures the latest completed user/assistant turn on `session.idle`.
- Fails open when MemoryCore is unavailable, so coding sessions continue normally.
- Provides native OpenCode tools:
  - `tdai_memory_search`
  - `tdai_conversation_search`
  - `tdai_memory_status`
- Sends `team_id`, `agent_id`, and `user_id` on every request for v3 isolation.

## Requirements

- OpenCode with `@opencode-ai/plugin` 1.18.16 or newer.
- Node.js 22.16 or newer.
- A running TencentDB Agent Memory service.
- A service ID and API key.

## Install from this repository

Until the adapter is published, clone the repository and install the adapter path in OpenCode's
global config directory:

```bash
mkdir -p ~/.config/opencode
cd ~/.config/opencode
npm install /path/to/TencentDB-Agent-Memory/adapters/opencode
```

Add the package to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["tencentdb-agent-memory-opencode-adapter"]
}
```

OpenCode installs npm plugins with Bun at startup. Restart OpenCode after changing the plugin list.

## Configure

Set the following environment variables before starting OpenCode:

```bash
export TDAI_MEMORY_ENDPOINT="http://127.0.0.1:8420"
export TDAI_MEMORY_API_KEY="replace-me"
export TDAI_MEMORY_SERVICE_ID="memory-service"
export TDAI_MEMORY_TEAM_ID="my-team"
export TDAI_MEMORY_AGENT_ID="opencode"
export TDAI_MEMORY_USER_ID="my-user"
```

Required variables:

| Variable | Purpose |
| --- | --- |
| `TDAI_MEMORY_API_KEY` | Bearer token used for MemoryCore requests |
| `TDAI_MEMORY_SERVICE_ID` | Value of the `x-tdai-service-id` header |
| `TDAI_MEMORY_TEAM_ID` | v3 team isolation identifier |
| `TDAI_MEMORY_AGENT_ID` | v3 agent isolation identifier; `opencode` is recommended |
| `TDAI_MEMORY_USER_ID` | v3 user isolation identifier |

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TDAI_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | MemoryCore endpoint |
| `TDAI_MEMORY_TASK_ID` | unset | Optional task isolation identifier |
| `TDAI_OPENCODE_TIMEOUT_MS` | `5000` | Request timeout, 100-60000 ms |
| `TDAI_OPENCODE_RECALL_LIMIT` | `5` | Maximum recalled atomic memories, 1-20 |
| `TDAI_OPENCODE_MAX_CONTEXT_CHARS` | `8000` | Maximum injected context size |
| `TDAI_OPENCODE_RECALL_ENABLED` | `true` | Enable automatic recall |
| `TDAI_OPENCODE_CAPTURE_ENABLED` | `true` | Enable completed-turn capture |
| `TDAI_OPENCODE_ALLOW_INSECURE_HTTP` | `false` | Allow non-loopback plaintext HTTP |

Remote plaintext HTTP is rejected by default because it would expose the bearer token. Use HTTPS
for remote MemoryCore deployments.

## Lifecycle

1. `chat.message` records the latest user text as the recall query.
2. `experimental.chat.system.transform` recalls memory and appends a bounded, untrusted context
   block to the system prompt.
3. `session.idle` loads the session history and captures the latest completed turn.
4. An in-process content hash prevents duplicate capture when OpenCode emits repeated idle events.

The duplicate guard is process-local. A restart immediately after the server accepts a capture can
still repeat the final turn because `/v3/conversation/add` assigns message IDs server-side.

## Security behavior

- Recalled content is data, not instructions. Boundary markers inside stored memory are escaped.
- Recall size is bounded before it enters the model context.
- Credentials are read from the environment and never written into OpenCode messages.
- Hook failures are logged through `client.app.log`; they do not block the coding session.
- The adapter never logs prompts, responses, API keys, or recalled memory content.

## Development

```bash
cd adapters/opencode
npm install
npm run check
npm run pack:check
```

Tests cover configuration validation, prompt-boundary escaping, recall injection, completed-turn
capture, duplicate idle events, and native tool registration.
