# Claude Code Adapter

The Claude Code adapter is a self-contained plugin that maps native lifecycle
hooks to the existing TDAI Gateway.

## Lifecycle mapping

| Claude event | Memory action |
|---|---|
| `UserPromptSubmit` | persist the prompt, retry failed captures, recall memory, return `additionalContext` |
| `Stop` | pair the persisted prompt with `last_assistant_message`, persist the turn, then capture |
| `SessionEnd` | best-effort retry of one turn and session flush |

Recall context is capped at 8,000 characters. Network failures are fail-open:
the hook returns success, emits valid JSON on stdout, and writes diagnostics
only to stderr. Dynamic L1 evidence and stable L2/L3 context remain separately
labeled inside the injected memory block.

## Build and run locally

```bash
npm install
npm run build
claude plugin validate --strict ./claude-code-plugin
claude --plugin-dir ./claude-code-plugin
```

The build stages the bundled hook at
`claude-code-plugin/scripts/memory-hook.mjs`. Plugin hooks use exec form:
`node` is the executable and the bundle path is a separate argument, so paths
with spaces work on macOS, Linux, and Windows.

## Gateway configuration

The plugin inherits these variables from the Claude Code process:

| Variable | Default | Meaning |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway root |
| `TDAI_GATEWAY_API_KEY` | unset | Optional Bearer token |
| `TDAI_GATEWAY_TIMEOUT_MS` | `5000` | Prompt/capture request timeout |
| `TDAI_GATEWAY_ALLOW_REMOTE` | `false` | Explicit non-loopback opt-in |
| `TDAI_CLAUDE_SESSION_KEY` | derived | Optional fixed session key |

## Durable retry behavior

Before network I/O, hook state is written atomically beneath
`${CLAUDE_PLUGIN_DATA}/memory-tencentdb/state/`. Filenames are SHA-256 digests
of Claude session IDs.

- A failed capture remains in the per-session queue.
- One queued turn is retried before each prompt, with a two-second internal
  budget so recall retains most of the hook's ten-second budget.
- Each session retains at most 100 failed turns.
- Queued turn data across all sessions is capped at 5 MiB; the oldest failed
  turns are removed first without deleting pending prompts.
- Original user/assistant timestamps are reused on retry so the Gateway's
  checkpoint logic can suppress duplicate L0 writes.
- Invalid or truncated state JSON is moved to a hashed `.corrupt-*` file and a
  clean state is created, so one interrupted write cannot disable future hooks.

`SessionEnd` gives the queued retry and session-end request at most 400 ms
each, keeping the combined network budget below the hook's one-second timeout.
It still attempts session-end when the queued retry fails or times out.
Remaining capture failures stay queued for the next run.

The plugin follows the current
[Claude Code Hooks reference](https://code.claude.com/docs/en/hooks) and
[plugin reference](https://code.claude.com/docs/en/plugins-reference):
plugin paths use exec form with `args`, state lives under
`${CLAUDE_PLUGIN_DATA}`, `Stop` consumes `last_assistant_message`, and all
events return valid Hook JSON.
