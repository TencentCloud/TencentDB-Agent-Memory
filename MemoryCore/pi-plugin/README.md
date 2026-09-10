# @tencentdb-agent-memory/pi-tdai-client

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that routes Pi
through the [TencentDB Agent Memory v2](https://github.com/TencentCloud/TencentDB-Agent-Memory)
proxy for team memory: L3 persona, L2 scene index, L0 conversation capture, and
on-demand L0/L1/L2 search.

The plugin carries **routing + a dynamic per-session `x-conversation-id` header + an interactive Team/Agent/Task picker**. All memory capability is delivered server-side by the proxy (injected into the system prompt and captured from the response). This keeps the extension minimal and keeps memory logic in one place. (Scope: routing + header + picker; no client-side recall/capture.)

## Interactive session init (default)

On the **first turn of each new Pi session**, if no preset identity is set (see
below), the proxy sends a Team → Agent → Task form and this plugin renders it as
a Pi-native TUI menu: `↑↓` to navigate, `Enter` to select, `Esc` to cancel. Pick
once and the session is bound for its lifetime — the chosen team's memory (L3
persona, L2 scene index) is injected and the conversation is captured (L0).

This matches the Claude Code / CodeBuddy UX. The picking is **manual**, by
design — which team/agent a piece of work belongs to is a human-intent decision,
not auto-inferred from your prompt.

Requires interactive mode (the default `pi` TUI). In `pi -p` / RPC / non-TUI
modes the picker cannot render; set the preset env vars instead (below).

## Prerequisites

- Pi installed and on your `PATH`.
- A running TDAI v2 stack (Memory Core + Proxy).
- In the TDAI panel: a **Team** and an **Agent**. A **Task** is optional —
  memory works without one (broad recall); create + link a Task only if you
  want to filter recall to a specific project.

## Configure (env vars, no secrets in files)

| Env var | Required | Default | Notes |
|---|---|---|---|
| `TDAI_PROXY_URL` | no | `http://127.0.0.1:8096` | proxy host:port |
| `TDAI_SPACE_ID` | no | `default` | memory instance id |
| `TDAI_AGENT_SOURCE` | no | `pi` | first-class path; set `codebuddy` to fall back to the CodeBuddy profile for debugging |
| `TDAI_TEAM_ID` | no | — | **preset fallback** — set to skip the interactive picker (CI, scripts, fixed-context users). From the panel (Team) |
| `TDAI_AGENT_ID` | no | — | **preset fallback** — same as team. From the panel (Agent) |
| `TDAI_TASK_ID` | no | — | optional; from the panel (Task linked to the agent). When set, recall narrows to that task; when absent, recall is broad across the agent's memories |
| `TDAI_USER_KEY` | **yes** | — | the **user's** API key (panel → API Key), NOT the admin/gateway key |
| `TDAI_MODEL` | no | `glm-5.2-vision` | **fallback model** — used before the first refresh, offline, and against proxies without the `/models` route |

Set these in your shell or Pi's env block; the plugin reads them at load.

**Dynamic model catalog:** on refresh the provider fetches
`GET {TDAI_PROXY_URL}/{TDAI_AGENT_SOURCE}/{TDAI_SPACE_ID}/v1/models` (user-key
authenticated) and replaces the model list with the upstream gateway catalog,
persisted across sessions. The static `TDAI_MODEL` entry is the fallback when
that endpoint is unreachable or the proxy predates the route. Requires proxy
build with `handleModelsCatalog` (`GET /:agent/:spaceId/v1/models`).

**Default usage is interactive:** set only `TDAI_USER_KEY` (and optionally
`TDAI_MODEL`), leave the identity vars unset, and pick Team/Agent/Task on the
first turn of each session. Set `TDAI_TEAM_ID`/`TDAI_AGENT_ID`/`TDAI_TASK_ID`
only when you want to skip the picker (CI, scripts, a fixed context).

## Install / load

**From npm** (also listed in the [Pi package gallery](https://pi.dev/packages)):

```bash
pi install npm:@tencentdb-agent-memory/pi-tdai-client
```

Then run (interactive mode — no identity env vars, the picker fires on turn 1):

```bash
export TDAI_USER_KEY=<your-user-key>
pi --provider tdai --model glm-5.2-vision
```

**Quick test** (throwaway load, from a checkout of this repo):

```bash
TDAI_USER_KEY=<your-user-key> \
  pi -e ./MemoryCore/pi-plugin --provider tdai --model glm-5.2-vision
```

**Fixed identity** (skips the picker — for CI / scripts / a fixed context):

```bash
TDAI_USER_KEY=<your-user-key> TDAI_TEAM_ID=<...> TDAI_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider tdai --model glm-5.2-vision
```

(Add `TDAI_TASK_ID=<...>` only if you want task-scoped recall.)

Auto-discover (global): symlink or copy into `~/.pi/agent/extensions/` and Pi
loads it on startup. Or use `pi install` (above) for npm-managed install.

## Verify (integration gate)

Confirm the proxy sees the `pi` agent-source and that memory is wired:

```bash
TDAI_USER_KEY=<your-user-key> TDAI_TEAM_ID=<...> TDAI_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider tdai --model glm-5.2-vision -p "say OK"
# Then check proxy logs:
docker logs tdai-proxy --tail 30 2>&1 | grep -E "agentSource|write-l0|register directly"
```

Expect `agentSource=pi`, `register directly`, and a `write-l0` line. If you see
`agentSource=codebuddy` (or the default) or no `write-l0`, the base URL or
identity headers are wrong.

## Troubleshooting

- **Interactive mode is the default.** With no `TDAI_TEAM_ID`/`TDAI_AGENT_ID`/`TDAI_TASK_ID` set, the first turn of a new session shows a Team → Agent → Task picker (↑↓ + Enter). The session binds to your pick for its lifetime. Requires interactive (TUI) mode.
- **Use the user's API key, not the admin key.** The proxy validates the
  `Authorization: Bearer` against the user's API key (panel → API Key). The
  admin/gateway key is for internal endpoints, not client routing.
- **`x-task-id` is optional.** Memory works with just team + agent (broad
  recall). Set `TDAI_TASK_ID` only to narrow recall to a specific Task. A
  stale/unknown task id is dropped with a warning and recall broadens — it
  does not block memory.
- **Non-interactive mode needs the preset env vars.** `pi -p` / RPC / non-TUI
  modes cannot render the picker. Set `TDAI_TEAM_ID`/`TDAI_AGENT_ID` to skip it.
- **Missing required env vars don't block Pi.** If `TDAI_USER_KEY` is unset, the
  extension logs a warning at load and skips registering the `tdai` provider —
  Pi starts normally, just without the TDAI provider available. Set the vars
  and restart Pi to enable it.
- **Fall back to the CodeBuddy profile for debugging.** Set
  `TDAI_AGENT_SOURCE=codebuddy` to route through the existing, battle-tested
  CodeBuddy profile (injection still works; anchoring is coarser). Useful to
  isolate whether an issue is Pi-specific or a proxy/config problem.
