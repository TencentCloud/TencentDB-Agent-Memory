# TencentDB Agent Memory for Claude Code

This directory is a self-contained Claude Code plugin built on the official
[plugin](https://code.claude.com/docs/en/plugins),
[hooks](https://code.claude.com/docs/en/hooks), and
[MCP](https://code.claude.com/docs/en/mcp) extension points.

The plugin is a thin client. Keep one TencentDB Agent Memory Gateway running;
the Gateway remains the only owner of the memory core, SQLite files, extraction
scheduler, and optional vector store.

## What it does

- `UserPromptSubmit`: recalls memory and supplies it through
  `hookSpecificOutput.additionalContext`. The original prompt is saved locally
  before the network request. Stable persona/scene context is injected once per
  session (and again only when it changes), while relevant L1 memories remain
  per-turn context.
- `Stop`: pairs the saved prompt with the documented `last_assistant_message`
  field and captures the completed turn. It waits only for the local Gateway
  write, which prevents adjacent asynchronous turns from being mispaired.
- `SessionEnd`: asynchronously waits for an in-flight capture, then asks the
  Gateway to flush that session.
- MCP: exposes `tdai_memory_search`, `tdai_conversation_search`, and
  `tdai_memory_health` for explicit lookups. MCP tools do not capture ordinary
  turns, which avoids duplicate writes.

Hook failures are fail-open: Claude Code continues even if the Gateway is
offline. Automatic recall output is capped below Claude Code's 10,000-character
hook-output limit. Pending prompt state is stored under `CLAUDE_PLUGIN_DATA`,
which Claude Code preserves across plugin updates.

## Requirements

- Claude Code with plugin support
- Node.js `>=22.16.0`
- A local or reachable TencentDB Agent Memory Gateway

## 1. Start the Gateway

From the repository root:

```bash
npm install

export TDAI_LLM_API_KEY="your-provider-key"
export TDAI_LLM_BASE_URL="https://api.openai.com/v1"
export TDAI_LLM_MODEL="gpt-4o"
export TDAI_GATEWAY_API_KEY="choose-a-separate-gateway-secret"

npm run gateway
```

The Gateway defaults to `http://127.0.0.1:8420`. Verify it in another shell:

```bash
curl http://127.0.0.1:8420/health
```

For OpenRouter-backed extraction, the Gateway uses OpenRouter's
OpenAI-compatible API:

```bash
export TDAI_LLM_API_KEY="$OPENROUTER_API_KEY"
export TDAI_LLM_BASE_URL="https://openrouter.ai/api/v1"
export TDAI_LLM_MODEL="<an OpenRouter model slug enabled for your account>"
```

This is separate from Claude Code's own provider configuration. When Claude
Code itself uses OpenRouter, its Anthropic-compatible base URL is
`https://openrouter.ai/api`:

```bash
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
```

Keep the `/v1` difference exact: the Gateway speaks the OpenAI-compatible
protocol, while Claude Code speaks the Anthropic-compatible protocol. If
Claude Code has a cached Anthropic login, run `/logout` once and relaunch it.
See OpenRouter's
[Claude Code integration guide](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration).

## 2. Load the plugin

For a development checkout:

```bash
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
export TDAI_GATEWAY_API_KEY="choose-a-separate-gateway-secret"

claude plugin validate ./claude-code-plugin --strict
claude --plugin-dir ./claude-code-plugin
```

For a persistent marketplace installation:

```bash
claude plugin marketplace add TencentCloud/TencentDB-Agent-Memory
claude plugin install \
  tencentdb-agent-memory@tencentdb-agent-memory \
  --scope local
```

`--scope local` isolates the installation to the current project. Use
`--scope user` only when you want the plugin enabled for every project.

Inside Claude Code, use `/mcp` to confirm the `memory` server and `/hooks` to
inspect the three lifecycle hooks. `/reload-plugins` reloads local changes.

## Configuration

Set variables in the environment that launches Claude Code:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `TDAI_GATEWAY_API_KEY` | empty | Bearer token matching the Gateway |
| `TDAI_GATEWAY_TIMEOUT_MS` | `15000` | Adapter request timeout |
| `TDAI_CLAUDE_CAPTURE_TIMEOUT_MS` | `10000` | Stop-hook capture timeout (max `18000`) |
| `TDAI_CLAUDE_AUTO_RECALL` | `true` | Set `false` to disable the recall hook |
| `TDAI_CLAUDE_AUTO_CAPTURE` | `true` | Set `false` to disable the capture hook |
| `TDAI_CLAUDE_SESSION_PREFIX` | `claude-code` | Prefix for derived Gateway session keys |
| `TDAI_CLAUDE_SESSION_END_WAIT_MS` | `15000` | Maximum wait for the final async capture |
| `TDAI_USER_ID` | empty | Optional user identifier forwarded to the Gateway |

Session keys contain hashes of the project path and Claude session ID; raw
workspace paths are not sent to the Gateway. Scene navigation is also rewritten
to portable scene names, so a Gateway running in a VM or on another host does
not expose unusable host-local file paths to Claude Code.

If the Gateway listens beyond loopback, enable
`TDAI_GATEWAY_API_KEY` and use TLS or a trusted private network. The current
Gateway store is shared across projects. For hard project isolation, run a
separate Gateway with a separate `TDAI_DATA_DIR`.

## Troubleshooting

- `/mcp` reports disconnected: check that `node` is on the `PATH` inherited by
  Claude Code, then call `tdai_memory_health`.
- Recall warning says `UNREACHABLE`: verify `TDAI_GATEWAY_URL` and `curl` the
  health endpoint.
- HTTP 401: the plugin and Gateway values of `TDAI_GATEWAY_API_KEY` differ.
- No automatic memory: inspect `/hooks`; run Claude Code with `--debug`; ensure
  the two `TDAI_CLAUDE_AUTO_*` variables are not disabled.
- `health` is `degraded`: the Gateway is running, but an optional embedding
  store is unavailable. Keyword-backed behavior may still work.

The integration does not automate Claude Code authentication, alter device
identifiers, or bypass provider controls. It only uses documented local plugin
extension points and a user-configured Gateway.
