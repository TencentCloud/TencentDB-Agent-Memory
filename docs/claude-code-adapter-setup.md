# Claude Code Adapter Setup

This guide shows how to connect Claude Code to TencentDB Agent Memory through
Claude Code hooks and the existing TDAI Gateway.

## Data Flow

```mermaid
flowchart LR
  Claude["Claude Code"]
  Hook["Claude Code hook"]
  Adapter["handleClaudeCodeHook"]
  Gateway["TDAI Gateway"]
  Core["TdaiCore"]
  Store["L0/L1/L2/L3 storage"]

  Claude --> Hook
  Hook --> Adapter
  Adapter --> Gateway
  Gateway --> Core
  Core --> Store
```

## Hook Mapping

| Claude Code hook | Adapter action | Gateway endpoint |
| --- | --- | --- |
| `UserPromptSubmit` | Recall memory and inject additional prompt context | `POST /recall` |
| `Stop` | Pair the transcript's latest user prompt with `last_assistant_message` | `POST /capture` |
| `SessionStart` | Health-check the Gateway | `GET /health` |
| `SessionEnd` | Flush pending work without capturing the last turn again | `POST /session/end` |

## Gateway Configuration

Start the Gateway before launching Claude Code:

```bash
cd /path/to/TencentDB-Agent-Memory
TDAI_GATEWAY_HOST="127.0.0.1" \
TDAI_GATEWAY_PORT="8420" \
TDAI_LLM_API_KEY="sk-your-api-key" \
TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
TDAI_LLM_MODEL="deepseek-v4-pro" \
TDAI_LLM_DISABLE_THINKING="deepseek" \
npx tsx src/gateway/server.ts
```

For DeepSeek, use the OpenAI-compatible `/v1` endpoint for the Gateway. Claude
Code may use DeepSeek's Anthropic-compatible `/anthropic` endpoint, but the
Gateway's standalone runner calls OpenAI-compatible chat completions.

## Install the Hook Command

Install the package globally so Claude Code can resolve the hook command:

```bash
npm install --global @tencentdb-agent-memory/memory-tencentdb
```

For a source checkout, build the standalone entry and use its absolute path in
the settings below:

```bash
npm install
npm run build:plugin
node /absolute/path/to/TencentDB-Agent-Memory/dist/memory-tencentdb-claude-hook.mjs
```

## Claude Code Settings

Add hooks to `~/.claude/settings.json` or a project-level Claude Code settings
file. Hook commands inherit the environment of the `claude` process, so export
`TDAI_GATEWAY_URL` and, when enabled, `TDAI_GATEWAY_API_KEY` before starting
Claude Code.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memory-tencentdb-claude-hook",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memory-tencentdb-claude-hook",
            "timeout": 15
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memory-tencentdb-claude-hook",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memory-tencentdb-claude-hook",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Claude Code normally gives `SessionEnd` hooks only a short shutdown budget.
The explicit timeout above gives the Gateway's session flush enough time while
the adapter's HTTP timeout remains bounded by `TDAI_GATEWAY_TIMEOUT_MS`
(default: 10000).

The adapter keys memory by Claude's stable `session_id`, so changing directories
inside one Claude session does not split recall, capture, and flush across
different Gateway sessions.

## Smoke Test

Simulate a `UserPromptSubmit` hook:

```bash
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"'$PWD'","prompt":"What should I remember?"}' \
  | TDAI_GATEWAY_URL=http://127.0.0.1:8420 memory-tencentdb-claude-hook
```

The hook prints JSON with `hookSpecificOutput.additionalContext` when recall
returns non-empty context. Empty recall exits successfully with no output.

At `Stop`, Claude Code supplies the final response in
`last_assistant_message`. The adapter uses that field because the JSONL
transcript is written asynchronously, and reads the transcript only to find the
corresponding human prompt. Tool-result rows and meta/sidechain rows are not
captured as user messages. Transcript timestamps are forwarded to the Gateway,
allowing its atomic checkpoint to ignore exact hook retries. Gateway errors are
written to stderr for diagnostics but always return exit code 0 so memory cannot
block Claude Code.

The hook provides automatic recall and capture only. It removes the core's
`memory-tools-guide` block because this adapter does not register
`tdai_memory_search` or `tdai_conversation_search` as Claude Code tools. Hosts
that expose those searches separately can use `CodingAgentGatewayClient`'s
`searchMemories()` and `searchConversations()` methods.
