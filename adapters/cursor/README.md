# Cursor adapter

This adapter gives Cursor cross-session TencentDB Agent Memory without routing model traffic or depending on a particular model provider. It combines Cursor Hooks with MCP:

- `sessionStart` recalls durable context and adds it to the new Composer session.
- `beforeSubmitPrompt` and `afterAgentResponse` pair a completed turn by Cursor's stable `conversation_id` and per-turn `generation_id`, then send it to Gateway `/capture` exactly once.
- `sessionEnd` flushes the memory pipeline.
- MCP exposes explicit recall and search tools to Cursor Auto and named models.

Model requests still use Cursor's native provider path. The adapter therefore works with Cursor Free/Auto; it does not require a custom model or OpenAI Base URL override.

## Model and plan compatibility

This adapter intentionally keeps model requests on Cursor's native provider path. Cursor Free accounts may be restricted to the **Auto** model, while named models depend on the user's Cursor plan and account permissions. The adapter does not bypass these restrictions.

The integration uses Cursor's public Agent Hooks and MCP interfaces instead of replacing Cursor's model endpoint:

- Hooks run at Cursor session and agent lifecycle boundaries.
- `sessionStart` recalls TencentDB Agent Memory before the agent starts working.
- `beforeSubmitPrompt` and `afterAgentResponse` capture and pair the completed turn.
- MCP tools let the active agent explicitly recall and search memory.
- Cursor continues to send model requests through the provider selected in Cursor.

This design works for Cursor Free/Auto without named-model access, remains independent of the selected model provider, avoids requiring a TencentDB model proxy endpoint, and does not change Cursor account, billing, entitlement, or provider configuration. Named models can use the adapter when the user's Cursor plan makes them available; model availability remains controlled by Cursor.

## Requirements

- Cursor with Agent Hooks and local plugin support
- Node.js 22 or later
- A running TDAI Gateway (default: `http://127.0.0.1:8420`)

The Gateway already provides `/recall`, `/capture`, `/search/memories`, `/search/conversations`, and `/session/end`; this adapter is only a thin Cursor integration over those official APIs.

## Installation

Use the installer so the installed configuration contains the actual Node executable and plugin paths. This avoids Cursor extension-host PATH failures, workspace-relative MCP paths, and unresolved `${PLUGIN_ROOT}` values:

```bash
node ./adapters/cursor/scripts/install.mjs
node ./adapters/cursor/scripts/install.mjs --dry-run
node ./adapters/cursor/scripts/install.mjs --target /custom/plugin/path
```

The default target is:

```text
~/.cursor/plugins/local/tencentdb-agent-memory
```

Restart Cursor or run `Developer: Reload Window`. In **Customize → Plugins**, configure:

- `TDAI_GATEWAY_URL`: Gateway base URL.
- `TDAI_GATEWAY_API_KEY`: optional Gateway Bearer token. Never commit it.
- `TDAI_CURSOR_AGENT_ID`: stable Cursor memory scope, default `cursor`. Use different values to isolate projects.

The resulting Gateway `session_key` is `agent:<agent-id>:cursor`; the original Cursor `conversation_id` is retained as `session_id`. New Composer conversations receive different session IDs but share this Cursor memory scope. Another client shares it only if it explicitly uses the same `session_key` or the service provides a common agent-isolation mapping; matching display names alone are not proof of cross-client sharing.

> `TDAI_GATEWAY_API_KEY` is a Gateway Bearer token, not a MemoryProxy business-user `user_key`. Never commit or publish credentials; rotate any credential that has been exposed.

## MCP tools

- `memory_status`: Gateway health and current scope
- `memory_recall`: relevance-based long-term recall
- `memory_search`: extracted-memory search
- `conversation_search`: raw L0 conversation search

The included Always Rule asks Cursor to use these tools when previous work may matter. Recalled content is explicitly treated as untrusted data, not instructions.

## Verification

1. Open Composer A with model **Auto**.
2. Send: `The release codename is North Star and the deployment window is Thursday at 21:00.`
3. Confirm Gateway `/capture` records one turn with the same Cursor conversation ID.
4. Continue the same Composer and confirm `conversation_id` remains stable but `generation_id` changes.
5. Open Composer B and ask: `What are the release codename and deployment window?`
6. Confirm `memory_recall` returns `North Star` and `Thursday at 21:00`.
7. Repeat an `afterAgentResponse` payload and confirm no duplicate capture.
8. Stop the Gateway and confirm Cursor still works; hooks are fail-open and report diagnostics only in the Hook output channel.

## Verified capabilities

| Capability | Status |
| --- | --- |
| Cursor Free / Auto | Locally verified |
| Automatic Hook pairing and capture | Locally verified |
| MCP status, recall, and search tools | Locally verified |
| Windows non-ASCII Hook input | Verified with malformed-JSON recovery and UTF-8 transcript fallback |
| Local Gateway SQLite L0 | Verified |
| Gateway outage fail-open | Verified |
Verification covers the Cursor client, Hook, MCP, and the configured Gateway interfaces. The storage backend and Gateway deployment remain deployment choices.

## Cursor compatibility notes

- On Cursor 3.17.8 for Windows, the Hook launcher can corrupt non-ASCII stdin before Node receives it. The adapter recovers reversible mojibake and reads the current turn from Cursor's UTF-8 transcript when bytes were lost.
- The current user entry may not exist in the transcript at `beforeSubmitPrompt`; transcript correction therefore runs at `afterAgentResponse` for both sides of the completed turn.
- Cursor can fail to launch `sessionEnd` during window shutdown with `MainThreadShellExec not initialized`. Completed turns are captured at `afterAgentResponse`, so correctness does not depend on `sessionEnd`.
- Abandoned pending turns expire after 7 days; idempotency markers expire after 30 days.

## Current boundary

Hooks and MCP can recall, search, and capture conversations. Model requests continue through Cursor's native provider configuration; this adapter does not intercept or rewrite provider request bodies. Further memory processing is handled by the configured Gateway.
