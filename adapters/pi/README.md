# Pi

> agentSource: `pi` | Protocol: OpenAI Chat Completions | Session Init: header preset (no interactive form)
>
> Chinese documentation: [README_CN.md](README_CN.md)

---

## 1. Client configuration

Pi connects to MemoryProxy through the custom provider in `~/.pi/agent/models.json`.
No plugin, hook, MCP server, or Pi source change is required.

Merge [`models.example.json`](models.example.json) into `models.json`, then replace:

- `<space-id>` with the Memory instance ID;
- `<upstream-model-id>` with the model ID configured behind MemoryProxy.

Set the environment variables referenced by the example:

```bash
export TDAI_MEMORY_USER_KEY='<sk-mem-user-key>'
export TDAI_MEMORY_TEAM_ID='<team-id>'
export TDAI_MEMORY_AGENT_ID='<agent-id>'
export TDAI_MEMORY_TASK_ID='<task-id>'
```

PowerShell:

```powershell
$env:TDAI_MEMORY_USER_KEY = '<sk-mem-user-key>'
$env:TDAI_MEMORY_TEAM_ID = '<team-id>'
$env:TDAI_MEMORY_AGENT_ID = '<agent-id>'
$env:TDAI_MEMORY_TASK_ID = '<task-id>'
```

Field summary:

- `baseUrl` — MemoryProxy address plus `/pi/<spaceId>/v1`;
- `api` — must be `"openai-completions"`;
- `apiKey` — the authenticated user's `sk-mem-...` key;
- `headers` — the Team, Agent, and Task preset used for non-interactive registration;
- `compat` — enables Pi's native per-session `x-session-id` header;
- `models[].id` — must match a model supported by the MemoryProxy upstream.

Select `tdai-memory/<upstream-model-id>` from Pi's model selector after starting MemoryProxy.

Request path: `POST /pi/:spaceId/v1/chat/completions`.

---

## 2. Session ID

| Priority | Header | Source |
|---|---|---|
| 1 | `x-conversation-id` | Optional wrapper or upstream proxy |
| 2 | `x-session-id` | Pi native session affinity |

The example enables:

```json
{
  "sendSessionAffinityHeaders": true,
  "sessionAffinityFormat": "openrouter"
}
```

Pi then sends its current runtime session ID as `x-session-id`. MemoryProxy already
uses this header as a conversation identity, so new, resumed, and concurrent Pi
sessions do not need a custom header hook.

---

## 3. Session Init

### Core difference: header preset, no interactive form

Pi does not provide a built-in question tool that MemoryProxy can use for asset
selection. Session registration therefore depends on the provider headers:

| Header | Description | Required |
|---|---|---|
| `x-team-id` | Team ID | Yes |
| `x-agent-id` | Agent ID | Yes |
| `x-task-id` | Task ID | Yes |

Processing rules:

- all three IDs exist and validate against the authenticated user's visible assets: register the session and enable memory;
- a valid binding already exists for `x-session-id`: recover it and continue normally;
- a preset is missing, partial, or invalid: pass through this request without injection;
- the pass-through decision is request-local and never persists a bypass for the Pi session.

MemoryProxy must enable `sessionInit.enabled` and `sessionInit.headerAutoSelect.enabled`.
The default header names already match the example.

---

## 4. Request classification

Pi uses the same Chat Completions provider for the main agent loop and internal
summarization. The adapter distinguishes them as follows:

| Request | Classification | Memory side effects |
|---|---|---|
| Normal turn | `main` | Enabled after session registration |
| Tool-result turn | `main` | Enabled after binding recovery |
| Automatic compaction | `auxiliary` | Disabled |
| Branch summary | `auxiliary` | Disabled |
| Unknown or partial match | `main` | Conservative fallback |

An auxiliary match requires the complete Pi `0.84.2` summary envelope: exactly
two messages, a known summary system prompt, a user `<conversation>` wrapper,
and no tools. A single weak signal never disables memory behavior.

---

## 5. User text extraction

Pi may send message content as a string or OpenAI text-content parts. The adapter
reuses the shared extractor for both shapes. The strict auxiliary-request gate
excludes synthetic `<conversation>` summary input from L0 and Skill side effects;
the text extractor does not act on that weak signal alone.

---

## 6. Injection profile

Pi shares `handleChatCompletions` with CodeBuddy, dsh, and OpenCode. After session
registration, MemoryProxy injects the standard blocks into the system message:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

The same shared pipeline handles binding recovery, L0 capture, Skill extraction,
Knowledge injection, authentication, observability, and credit reporting.

---

## 7. Special behavior

- **Shared handler**: Pi uses the generic OpenAI Chat Completions handler; there is no `piHandler.ts`.
- **First-class attribution**: the `/pi/` route sets `agentSource=pi` for session keys and telemetry.
- **No fabricated tool**: MemoryProxy never returns an unknown session-init tool to Pi.
- **Request-local fail-open**: an unavailable asset selection path does not poison later requests.
- **Session reset**: change the static asset headers and start a new Pi session; interactive `mem:session-reset` is not supported.

---

## 8. Environment variables

| Variable | Purpose |
|---|---|
| `TDAI_MEMORY_USER_KEY` | Memory user key used for authentication |
| `TDAI_MEMORY_TEAM_ID` | Header preset Team ID |
| `TDAI_MEMORY_AGENT_ID` | Header preset Agent ID |
| `TDAI_MEMORY_TASK_ID` | Header preset Task ID |

Pi resolves `$VARIABLE_NAME` values when loading `models.json`. Do not commit a
populated configuration containing literal credentials.

---

## 9. Known limitations

- Team, Agent, and Task IDs are static for one provider entry. Define another
  provider entry when a different asset binding is needed.
- Pi `0.84.2` has no built-in interactive asset-selection tool, so incomplete
  presets cannot be repaired inside the current conversation.
- Summary classification is validated against Pi `0.84.2`. Future Pi prompt-shape
  changes remain on the safe `main` path until explicitly verified.

---

## 10. FAQ

**Q: Is changing only `baseUrl` sufficient?**

A: No. The integration is zero-code, not zero-configuration. Keep the `compat`
session-affinity settings and all three asset headers from the example.

**Q: Why use `sessionAffinityFormat: "openrouter"`?**

A: This format sends `x-session-id`, which MemoryProxy already recognizes. It
keeps each Pi runtime session isolated without an extension-owned hook.

**Q: What happens when an asset ID is wrong?**

A: MemoryProxy validates IDs against assets visible to the authenticated user.
The current request passes upstream without memory, and no persistent bypass is written.

**Q: Can model costs remain zero in `models.json`?**

A: Yes. Those values are Pi-side display metadata; MemoryProxy performs upstream
usage accounting independently.

---

## 11. Validation status

- Pi `0.84.2` configuration-only smoke test passed with `--no-extensions`;
- the captured request contained a dynamic `x-session-id` and all three preset headers;
- route normalization, credit attribution, provider configuration, and request classification tests pass.
