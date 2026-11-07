# @tencentdb-agent-memory/pi-tdai-client

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that routes Pi
through the [TencentDB Agent Memory v2](https://github.com/TencentCloud/TencentDB-Agent-Memory)
proxy for team memory: L3 persona, L2 scene index, L0 conversation capture, and
on-demand L0/L1/L2 search.

The plugin carries **only routing + dynamic session/branch identity headers**.
All memory capability is delivered server-side by the proxy
(injected into the system prompt and captured from the response). This keeps
the extension minimal and keeps memory logic in one place. (Scope: routing +
header; no client-side recall/capture.)

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
| `TDAI_BRANCH_ISOLATION` | no | `1` | isolates Pi `/tree` branches; set to `0`, `false`, `off`, or `no` to opt out |

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

## Pi `/tree` branch isolation

Branch isolation is enabled by default. When `/tree` moves to a branch that
does not already carry an identity marker, the extension appends a private
custom session entry named `tdai-memory/branch@1`. The marker is not sent to
the model. It is forwarded to the proxy as routing metadata, where it scopes
the normal `pi-<session-id>` conversation identity to the active branch.

Returning to a previously marked branch restores the same memory identity.
Two branches from the same Pi session therefore capture and recall different
L0/L1 memory, while team, user, agent, task, L2, and L3 identity are unchanged.
The marker is persisted in the Pi session rather than derived from a local
path or machine name, so moving the session does not change its identity.

Sessions created before branch isolation have no marker. They continue using
the exact pre-existing `pi-<session-id>` identity and emit a warning instead
of failing or being silently migrated. Using `/tree` creates a marker only on
the newly selected unmarked branch. To keep the legacy behavior for every
branch, set:

```bash
TDAI_BRANCH_ISOLATION=0
```

The version is part of the custom entry type. A future incompatible format
must use a new type such as `tdai-memory/branch@2`; v1 readers ignore unknown
versions and fall back safely instead of interpreting a new payload as v1.

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

To verify branch isolation, start one Pi session, create two sibling routes
with `/tree`, and send one turn on each route. Proxy inspection/logging should
show the same base Pi session with two different derived conversation IDs.

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
