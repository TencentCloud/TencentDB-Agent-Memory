# Cursor custom-endpoint integration with the existing MemoryProxy

## Status and hypothesis to validate

This document is an integration proposal and validation plan. It does not include runtime code.

The key hypothesis is that an eligible Cursor account can configure an OpenAI-compatible custom endpoint, Base URL, and API key. Whether this capability is restricted to Cursor Pro, available on other plans, or subject to account-specific entitlements must be verified with real accounts before the documentation defines a Free/Pro boundary.

## Scope

MemoryProxy already implements authentication, session registration, identity isolation, memory injection, provider forwarding, streaming, and conversation recording for supported agents such as Claude Code, Codex, and CodeBuddy. This proposal does not redesign those gateway capabilities.

The Cursor-specific work is to:

1. document how to point Cursor's custom OpenAI-compatible endpoint to the existing MemoryProxy;
2. determine how Cursor supplies the headers and stable identifiers required by MemoryProxy;
3. validate Cursor request, response, streaming, and model-provider compatibility;
4. record the tested configuration and results in English and Chinese.

## Relationship to the Hooks + MCP adapter

PR [#1138](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1138) proposes the Cursor Hooks + MCP adapter. It captures conversations and provides explicit memory recall and search without placing MemoryProxy in the model-request path. Recall through that path depends on the agent calling an MCP tool.

This document is a companion to #1138, not a replacement for it. If #1138 is merged, Hooks + MCP remains the usable Cursor Free/Auto path. Custom-endpoint Proxy routing is an optional extension for accounts where the endpoint capability is available. Any Proxy-specific runtime changes must be developed and reviewed separately and must not be mixed into the #1138 adapter code.

## Proposed configuration with the existing Proxy

The user would configure Cursor with:

- Base URL: `http://<proxy-host>:<port>/<agent-source>/<spaceId>`;
- API key: the TencentDB business user's `user_key`;
- a model name supported by the configured upstream provider.

MemoryProxy then receives the OpenAI-compatible request, performs its existing authentication and session flow, injects recalled memory, forwards the request to the configured provider, returns the response or stream, and records the completed conversation.

The current generic Proxy contract also requires `x-team-id`, `x-agent-id`, `x-task-id`, and `x-conversation-id`. A central validation item is whether Cursor can attach these custom headers. If it cannot, the test must determine whether MemoryProxy's existing interactive/default task flow is sufficient or whether a small, separately reviewed Cursor-specific adapter is required.

The current list of supported `<agent-source>` values does not include `cursor`. Initial testing may use a documented compatible source only for protocol validation; production support should add and review an explicit Cursor source rather than permanently impersonating another client.

## Identity and turn mapping

The intended field sources are:

| MemoryProxy field | Source to validate |
| --- | --- |
| `user_key` | Cursor custom-endpoint API key, sent as `Authorization: Bearer ...` |
| `team_id` | `x-team-id`, configured from the TencentDB admin panel |
| `agent_id` | `x-agent-id`, configured from the TencentDB admin panel |
| `task_id` | `x-task-id`, configured from the TencentDB admin panel; it is not a per-turn generation ID |
| `session_id` | Cursor `conversation_id`, sent as `x-conversation-id` if Cursor exposes and forwards it |
| turn pairing | Cursor `generation_id`, as used by #1138; it must not replace the stable session ID |

The main unknown is whether Cursor exposes `conversation_id` and `generation_id` to custom-endpoint requests or permits them to be forwarded as headers/body metadata. If it does not, the Proxy path needs a documented fallback that does not conflate a task, session, and individual generation.

## User-visible behavior and trade-offs

- The #1138 Hooks path is fail-open: a memory outage does not block normal Cursor model use.
- The Proxy path is naturally fail-closed: if MemoryProxy is unavailable, model requests routed through it fail.
- Routing through MemoryProxy sends the complete model traffic—including prompts, selected code/context, tool data, and responses—through the configured gateway. Users must be informed of this data flow and should review the gateway's privacy, access-control, logging, and retention policies.

## Validation plan and results

No runtime results are claimed yet. The following matrix must be completed with real account plan/version details, Cursor version, Proxy version, provider, model, observed result, and evidence:

- [ ] Confirm which Cursor plans/accounts expose custom OpenAI-compatible Base URL configuration.
- [ ] Confirm Base URL path construction and whether Cursor appends `/v1/chat/completions` correctly.
- [ ] Verify non-streaming request and response schemas.
- [ ] Verify streaming request and response schemas and stream termination.
- [ ] Verify `Authorization` and support for required custom identity headers.
- [ ] Verify tool-call request/response fields and multi-step tool execution.
- [ ] Verify reasoning-content and usage fields without loss or schema errors.
- [ ] Verify availability and stability of `conversation_id` and `generation_id`.
- [ ] Verify retry, timeout, cancellation, disconnect, and upstream error propagation.
- [ ] Verify multiple providers and provider-specific model parameters.
- [ ] Record any additional Cursor restrictions on custom endpoints, models, certificates, or routing.
- [ ] Confirm session registration, memory injection, response delivery, and conversation persistence in MemoryProxy.

This proposal is provided for review and subsequent iterative implementation. I do not have access to an account with the required custom-endpoint capability, so I cannot currently complete the local end-to-end validation above.
