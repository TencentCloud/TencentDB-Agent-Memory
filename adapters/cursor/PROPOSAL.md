# Cursor Pro TencentDB Proxy routing proposal

## Background and Cursor plan differences

Cursor Free currently provides the built-in `Auto` model, but does not provide an OpenAI-compatible custom Base URL configuration. Cursor Pro is the plan that opens custom model endpoint capabilities. This difference determines which integration path can be used:

- Cursor Free/Auto uses the existing public Hooks + MCP adapter.
- Cursor Pro may additionally use a TencentDB Proxy as a custom OpenAI-compatible model endpoint.

## Current Cursor Free adapter

The current Cursor Free/Auto adapter uses MCP and public Agent Hooks. It can capture completed conversations and read or write TencentDB memory:

- Hooks capture prompts and responses at Cursor lifecycle events.
- `sessionStart` can recall context for a new session.
- MCP tools provide explicit memory status, recall, memory search, and conversation search.

This integration does not put TencentDB in Cursor's model-request path. Memory recall therefore depends on the model or agent actively calling the MCP tools; it is not directly injected into every model request by TencentDB.

## Proposed Cursor Pro path

Cursor Pro's custom OpenAI-compatible endpoint can be configured to point to TencentDB Proxy. This allows all model traffic for that Cursor configuration to pass through the Proxy:

```text
Cursor Pro
  -> TencentDB Memory Proxy (OpenAI-compatible Base URL)
      -> configured model provider
      <- provider response or stream
  <- Cursor-compatible response or stream
```

At the gateway layer, TencentDB Proxy can inject relevant memory into the request before forwarding it to the selected provider. This provides request-time memory enhancement while preserving Cursor's model selection experience through the Proxy's provider routing configuration.

## Proposed operation flow

1. The user configures TencentDB Proxy as Cursor's OpenAI-compatible Base URL and enters the Proxy API key.
2. Cursor sends a model request to the Proxy using its compatible request protocol.
3. The Proxy authenticates the request and maps it to a TencentDB memory identity.
4. The Proxy resolves the configured provider and model route.
5. The Proxy recalls relevant TencentDB memory and injects the resulting context into the model request.
6. The Proxy forwards the enhanced request to the selected model provider.
7. The Proxy returns the provider's response or stream to Cursor without breaking supported fields.
8. The Proxy captures the completed user/assistant turn and persists it into TencentDB memory.

Provider API keys should be managed by the Proxy deployment. They should not be embedded in the adapter or committed to the repository.

## Identity and session mapping

The proposed mapping is:

| TencentDB field | Proposed source |
| --- | --- |
| `user_key` | Authenticated TencentDB account |
| `team_id` | Configured team or project scope |
| `agent_id` | Stable Cursor adapter identifier |
| `task_id` | Current Cursor task or conversation scope |
| `session_id` | Cursor conversation or session identifier |

If Cursor forwards a stable conversation identifier, the Proxy should preserve it as `session_id`. If it does not, the integration needs an explicit session-id setting or another client-side identifier that remains stable for the conversation. A display name alone should not be treated as a stable session identity.

## Required validation before implementation

The following items require testing with Cursor Pro and the official environment:

- Custom OpenAI-compatible endpoint acceptance and configuration behavior;
- Compatibility of non-streaming and streaming request/response schemas;
- Authentication header forwarding and API-key semantics;
- Forwarding of tool-call, reasoning-content, usage, and related response fields;
- Availability and stability of a Cursor conversation or session ID;
- Retry, timeout, cancellation, and error propagation behavior;
- Compatibility with multiple model providers and provider-specific parameters;
- Any additional Cursor restrictions on custom endpoints, models, or routing.

## Relationship to the existing adapter

Hooks + MCP remain the formal, usable Cursor Free/Auto implementation. They continue to provide conversation capture and explicit memory read/write without changing Cursor's native model-provider path.

Proxy routing is an optional extension path for Cursor Pro accounts that can configure a custom model endpoint. Pro routing logic should be developed and reviewed independently and must not be mixed into the existing Free/Auto adapter code.

This document is a design proposal for review and future iteration. The corresponding runtime code has not been developed. I do not have a Cursor Pro account, so I cannot complete local end-to-end testing of this logic.
