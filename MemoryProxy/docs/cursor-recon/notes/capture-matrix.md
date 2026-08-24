# Cursor Capture Matrix

| ID | User action | UTC/local time | Host/path | Classification | Conversation candidate | Sanitized fixture | Notes |
|---|---|---|---|---|---|---|---|
| 01 | First prompt in new conversation | 2026-08-24 22:01 CST | `/v1/chat/completions` | Main | No dedicated header observed | `01-new-conversation.json` | Three-message first frame; streaming request |
| 02 | Second prompt in same conversation | 2026-08-24 22:03 CST | `/v1/chat/completions` | Main | Message history only | `02-same-conversation.json` | History grew from 3 to 5 messages |
| 03 | Native `AskQuestion` UI turn | 2026-08-24 | `/v1/chat/completions` | Main/tool use | No dedicated header observed | `04-ask-question-request.json`, `05-ask-question-result.json` | Ten explicit options displayed plus `Other...` |
| 04 | First prompt in another conversation | 2026-08-24 22:04 CST | `/v1/chat/completions` | Main | No dedicated header observed | `03-another-conversation.json` | Reset to the same three-role first-frame pattern |
| 05 | Auxiliary request | | | Pending | | | |

## Session identity comparison

| Candidate field/header | Scenario 01 | Scenario 02 | Scenario 04 | Same within conversation? | Different across conversations? | Conclusion |
|---|---|---|---|---|---|---|
| Cursor-specific HTTP header | Absent | Absent | Absent | No | No | No session/conversation header observed |
| Root `user` body field | Same account hash | Same account hash | Same account hash | Yes | No | Account identity, not conversation identity |
| Message-history shape | 3 messages | 5 messages | 3 messages | Evolves | Resets | Usable for fresh/history detection, not a stable ID by itself |

## First-frame metadata

| Message index | Role | Stable signature | Present in later turns? | Classification |
|---|---|---|---|---|
| 0 | `system` | Same sanitized content length and stable hash in both captured new conversations | Yes; remains at history index 0 | Cursor base system prompt |
| 1 | `user` | Same sanitized content length and stable hash in both captured new conversations | Yes; remains at history index 1 | Cursor-generated first-frame metadata |
| 2 | `user` | Content changes with the user's first prompt; the same sanitized hash persists into the second turn of that conversation | Yes; followed by assistant and later user messages | First real human query and conversation-ID fallback anchor |

## Ask-user tool

- Tool name: `AskQuestion`
- Top-level fields: optional `title`; required `questions`
- Question fields: required `id`, `prompt`, `options`; optional `allow_multiple`
- Option fields: required `id`, `label`
- Parameter casing: mixed (`AskQuestion` is PascalCase; `allow_multiple` is snake_case)
- Result shape: a `role: tool` message with `name: AskQuestion`, the originating `tool_call_id`, and array-valued `content`
- UI options limit: at least 10 explicit options; Cursor also displayed an automatic `Other...` entry. No pagination is required for the current four-stage init forms.

## Unknown and auxiliary traffic

| Signature | Suspected purpose | Evidence level | Expected Proxy behavior |
|---|---|---|---|
| | | | Fail-open passthrough with sanitized warning log |

## Experiment log

### Phase 1 Cursor UI session-init E2E

- Date: 2026-08-24
- Path: `/cursor/default/v1/chat/completions` through a public Cloudflare Quick Tunnel.
- Environment: real Cursor client; local fake metadata and fake OpenAI upstream (no production credentials or assets).
- Confirmed state sequence: `pending_asset_confirm` → `pending_team_select` → `pending_agent_select` → `pending_task_select` → `initialized`.
- Cursor returns the selected option `id` inside a `role:tool` content-block array. Form option IDs must therefore be directly resolvable by the shared state-machine extractors.
- The same derived `cursor-*` conversation ID remained stable through all five requests.
- Final streaming upstream response completed in Cursor and displayed `CURSOR_PROXY_E2E_OK`.
- Result: passed after fixing option-id resolution and making the E2E fake upstream honor `stream:true` with SSE.

### Attempt 01 — per-process proxy flags

- Cursor version: 3.17.8
- Account: Free / Auto
- Launch flags: `--proxy-server=http://127.0.0.1:8080 --ignore-certificate-errors --disable-quic`
- Result: update, marketplace, telemetry, and Statsig traffic were observable.
- Chat observation: repeated TLS handshake failures occurred for `api2.cursor.sh` around the chat turn.
- User-visible result: Cursor still completed the requested response.
- Conclusion: the completed chat was not captured as a decryptable HTTP request. It may have used a connection path that rejected the mitmproxy certificate or otherwise bypassed the observable HTTP flow.
- Evidence status: Confirmed for the TLS failures and absence of a captured chat request; the exact bypass mechanism is not yet confirmed.
- Fixture status: discarded because the capture contained only startup/telemetry traffic and did not answer the Phase 0 protocol questions.

### Attempt 01B — trusted Current User CA

- The mitmproxy CA was trusted in the Windows Current User Root store with explicit user approval.
- Ordinary `api2.cursor.sh` RPCs became decryptable.
- The observed IDE API uses paths such as `/aiserver.v1.<Service>/<Method>` and many bodies are Connect/Protobuf rather than OpenAI JSON.
- Cursor completed the test chat, but the first collector version wrote only on completed responses; the long-lived/streaming chat request did not appear as a completed response record.
- Collector change: add an immediate request event so streaming RPC metadata is persisted before response completion.
- Evidence status: Confirmed that the Free IDE-side protocol is not directly equivalent to the expected OpenAI Chat Completions Proxy ingress.

### Attempt 02 — immediate request capture through Electron proxy

- The collector was changed to persist requests immediately, before streaming responses complete.
- Regular `api2.cursor.sh` Connect/Protobuf RPCs were captured successfully.
- The same-conversation test turn completed in the Cursor UI, but no corresponding chat RPC appeared in the proxy capture.
- Conclusion: the Agent chat transport is likely owned by a background/extension process that does not inherit or honor Electron's `--proxy-server` setting. The exact owning process remains to be verified.
- Next experiment: use mitmproxy Windows local-capture mode scoped to the Cursor process family instead of relying on application proxy settings.
- Fixture status: discarded because it contained background/configuration RPCs but no chat request.

### Phase 0B tunnel preparation

- Cloudflare Quick Tunnel public reachability was verified independently through the probe health and model-list endpoints.
- Cursor-native proxy ingress was captured through Override Base URL at `/v1/chat/completions`.
- The collector preserves structural `input`/`output` containers while redacting nested `content` and `text` values.
- OpenAI-compatible SSE required a `finish_reason` frame, an empty-choice usage frame when `stream_options.include_usage=true`, `[DONE]`, and finite connection termination for Cursor to leave its loading state reliably.
- Root body field `user` is an account identifier and is hashed during capture; it is not a conversation ID.

### Phase 2 real Cursor + MemoryProxy acceptance

- Date: 2026-08-25 CST (2026-08-24 UTC in container logs).
- Path: `/cursor/default/v1/chat/completions` through a Cloudflare Quick Tunnel.
- Environment: real Cursor client, real MemoryProxy/MemoryCore stack, and a configured OpenAI-compatible upstream.
- The Cursor UI completed the full `asset_confirm -> team -> agent -> task` flow and the proxy reached `initialized`.
- The main streaming conversation completed successfully. Cursor replayed assistant tool-call messages without DeepSeek's non-standard `reasoning_content`; the Cursor adapter repaired every missing field before upstream forwarding, and no `invalid_request_error` was returned.
- The injection pipeline ran with `skill`, `knowledge`, and `tdai-memory`. Langfuse recorded the corresponding Skill and Memory injection spans.
- Normal conversation turns were archived to L0; proxy logs contained `tdai-recorder:write-l0` for the Cursor session.
- Memory recall returned existing L1 entries concerning the CURSOR-marker instruction in the real Cursor UI.
- `mem:help`, `mem:sync`, and `mem:create-skill` were intercepted locally with `success=true`.
- `mem:create-skill` produced `[skill-conversation-add] archived`; the asynchronous worker completed with `outcome=ok`. A zero-candidate extraction is valid for a short acceptance conversation and does not mean that the trigger failed.
- Langfuse received real streaming generations tagged `agent_source:cursor`, `protocol:openai`, and the sanitized Cursor session identifier.
- Client evidence was recorded for the form flow, injected assets, normal memory recall, and mem-command interception. Separate Langfuse evidence shows the `agent_source:cursor` tag.
- Known non-blocking environment warning: the session hook cache reported a foreign-key failure while its self-heal/prewarm path subsequently populated and served all configured injection blocks. This did not prevent injection, upstream completion, L0 archive, memory recall, or Skill archiving.
- Evidence handling: API keys, authorization values, account data, and local configuration are excluded. User/session identifiers must be blurred in any public screenshot.
