# @tencentdb-agent-memory/pi-tdai-client

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that routes Pi
through the [TencentDB Agent Memory v2](https://github.com/TencentCloud/TencentDB-Agent-Memory)
proxy for team memory: L3 persona, L2 scene index, L0 conversation capture, and
on-demand L0/L1/L2 search.

The plugin supplies routing, a dynamic per-session `x-conversation-id` header,
and six native read-only memory tools. The proxy still owns identity/scoping,
L3/L2 injection and conversation capture; reads happen only when requested.

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
| `TDAI_TEAM_ID` | **yes** | — | from the panel (Team) |
| `TDAI_AGENT_ID` | **yes** | — | from the panel (Agent) |
| `TDAI_TASK_ID` | no | — | optional; from the panel (Task linked to the agent). When set, recall narrows to that task; when absent, recall is broad across the agent's memories |
| `TDAI_USER_KEY` | **yes** | — | the **user's** API key (panel → API Key), NOT the admin/gateway key |
| `TDAI_MODEL` | no | `glm-5.2-vision` | must match a model the proxy forwards to |

Set these in your shell or Pi's env block; the plugin reads them at load.

## Install / load

Quick test (throwaway load):

```bash
TDAI_USER_KEY=<your-user-key> TDAI_TEAM_ID=<...> TDAI_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider tdai --model glm-5.2-vision
```

(Add `TDAI_TASK_ID=<...>` only if you want task-scoped recall.)

Auto-discover (global): symlink or copy into `~/.pi/agent/extensions/` and Pi
loads it on startup.

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

## Native memory reads

With the `tdai` provider selected, Pi exposes `tdai_memory_search`,
`tdai_atomic_query`, `tdai_conversation_search`, `tdai_conversation_query`,
`tdai_scenario_ls` and `tdai_read_scene`. These call the existing Memory Bridge
using the configured user key and the current Pi session. A historical
`session_id` argument selects records; it does not replace the authenticating
session header. Imported memory still requires the index's source `agent_id`
and remains subject to server authorization.

The tools send UTF-8 JSON bytes directly. This avoids a Windows Git Bash/native
curl combination converting non-ASCII `-d` arguments to the active legacy code
page. Changing only the Content-Type charset or using `curl.exe` does not fix
that conversion. HTTP and HTTPS use the existing `TDAI_PROXY_URL`; HTTPS uses
Node's normal certificate validation (including `NODE_EXTRA_CA_CERTS` supplied
at process startup), with no embedded certificate paths or disabled validation.

Restart Pi (or the Pi Web server process) after upgrading. In a new conversation,
ask Pi to list scenes with `tdai_scenario_ls` and pass one exact returned path to
`tdai_read_scene`. Verify the returned path matches and the body is readable.
A missing body or mismatched path is an explicit error. Offline mode, network
errors, cancellation and the 15-second deadline also report errors without
silently falling back to curl.

The existing server guidance still applies: at most three L0/L1 search calls
per turn; L3 and the initial L2 index arrive through injection. Other clients
without the native tools retain the server's curl instructions.

### Synthetic encoding reproduction

From `MemoryCore/pi-plugin` in Git Bash (Node 22+, Bash and curl on PATH):

```bash
node scripts/repro-utf8.mjs
```

The script sends only `场景/中文-路径.md` to an ephemeral loopback HTTP server,
prints received byte sequences for inline JSON and UTF-8 stdin, then closes its
server and child processes. It creates no files and uses no credentials or
model. On an affected Windows toolchain the inline path differs while stdin
matches; other toolchains may preserve both. Automated native-tool regression:
`npm test` in this directory with the development dependencies available.

## Troubleshooting

- **Use the user's API key, not the admin key.** The proxy validates the
  `Authorization: Bearer` against the user's API key (panel → API Key). The
  admin/gateway key is for internal endpoints, not client routing.
- **`x-task-id` is optional.** Memory works with just team + agent (broad
  recall). Set `TDAI_TASK_ID` only to narrow recall to a specific Task. A
  stale/unknown task id is dropped with a warning and recall broadens — it
  does not block memory.
- **Missing env vars don't block Pi.** If a required env var is unset, the
  extension logs a warning at load and skips registering the `tdai` provider —
  Pi starts normally, just without the TDAI provider available. Set the vars
  and restart Pi to enable it.
- **Fall back to the CodeBuddy profile for debugging.** Set
  `TDAI_AGENT_SOURCE=codebuddy` to route through the existing, battle-tested
  CodeBuddy profile (injection still works; anchoring is coarser). Useful to
  isolate whether an issue is Pi-specific or a proxy/config problem.
