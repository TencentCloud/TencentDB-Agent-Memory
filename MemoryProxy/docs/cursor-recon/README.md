# Cursor Protocol Reconnaissance

This directory stores sanitized protocol-reconnaissance material for the Cursor adapter.

## Environment

- Capture date: 2026-08-24
- OS: Windows
- Cursor version: 3.17.8 (`2fdd31c9f33f7fbe501f2d57772dc5bf64b63620`)
- Cursor environments: Free / Auto for Phase 0A; official account with Override Base URL for Phase 0B
- Capture tools: mitmproxy 12.2.3 (Phase 0A); sanitized HTTPS probe through Cloudflare Quick Tunnel (Phase 0B)
- Current scope: confirmed Proxy-inbound protocol reconnaissance

## Temporary CA trust record

- Installed in: Windows Current User trusted Root store
- Subject/issuer: `O=mitmproxy, CN=mitmproxy`
- SHA-1 fingerprint: `9a545caabb20b92dd11d8ccf49b8318cf1ed02aa`
- Installed with explicit user approval on: 2026-08-24
- Retention decision: keep installed during Phase 0/PR preparation; remove immediately before submitting the PR and verify removal by fingerprint.

## Important limitation

The Free-account capture may expose only the Cursor IDE-to-Cursor-backend protocol. It must not be represented as the final Cursor-backend-to-MemoryProxy protocol unless that relationship is independently verified.

The final proxy-inbound request shape, headers, session identity, streaming behavior, and tool-call compatibility must be captured or validated in an environment that supports Override Base URL.

## Directory classification

- `ide-side/`: requests observed from the local Cursor application. These may use Cursor's private internal protocol.
- `proxy-inbound/`: only requests confirmed to have reached a controlled Cursor custom endpoint or MemoryProxy ingress.
- `notes/`: comparison tables, observations, and experiment records.

Do not move an `ide-side` sample into `proxy-inbound` based only on structural similarity.

## Planned scenarios

1. First prompt in a new conversation.
2. Second prompt in the same conversation.
3. Agent/tool-use turn.
4. First prompt in another new conversation.
5. Auxiliary traffic such as title generation or context compaction, if observable.

## Redaction requirements

Before committing any fixture, replace sensitive values with `[REDACTED]`, including:

- `Authorization` and bearer tokens;
- cookies and session credentials;
- API keys;
- email addresses and account identifiers;
- private repository names;
- personal filesystem paths;
- private source code and real conversation content.

Header names may be retained for protocol analysis, but sensitive header values must not be retained.

## Evidence labels

Every conclusion must be marked as one of:

- Confirmed
- Inferred
- Not observed
- Requires Override Base URL E2E

## Phase 0 questions

| Question | Current status | Evidence |
|---|---|---|
| Is the observed payload the final Proxy ingress protocol? | Confirmed | Cursor Override Base URL reached the controlled public probe |
| Is the Proxy ingress OpenAI Chat Completions compatible? | Confirmed | `POST /v1/chat/completions`, `messages[]`, `tools[]`, `stream:true` |
| What identifies a stable conversation? | Partially confirmed | No dedicated session header; root `user` identifies the account; same-chat history grows while a new chat resets to the first-frame shape |
| What is Cursor's native ask-user tool schema? | Confirmed | `AskQuestion` with `questions[].{id,prompt,options,allow_multiple}` and `options[].{id,label}` |
| Can main and auxiliary requests be classified reliably? | Not observed | — |

Cursor displayed all 10 explicit options in the UI test and added `Other...`; the current session-init form does not need pagination.

The real Cursor UI session-init E2E also passed the full asset-confirm → team → agent → task flow and received a valid final SSE response from the controlled upstream. This validates the native `AskQuestion` request/response round trip, including Cursor's option-ID result behavior.

## Free-account boundary result

Phase 0A is complete. Windows process-scoped capture showed that the Free IDE Agent transport uses Cursor-private Connect/Protobuf RPCs, including `/agent.v1.AgentService/...` and `/aiserver.v1.AiService/...`. This is the IDE-to-Cursor-backend layer and is not an authoritative fixture for the Cursor-backend-to-custom-endpoint protocol.

No additional Free private-protocol reverse engineering is planned. Authoritative `proxy-inbound` fixtures will be captured in Phase 0B using a Cursor environment that supports Override Base URL and a controlled public HTTPS probe.
