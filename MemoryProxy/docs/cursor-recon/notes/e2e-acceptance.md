# Cursor Proxy E2E Acceptance

This report maps the real Cursor acceptance run to the maintainer's completion checklist. Public evidence must remain sanitized; credentials and account identifiers are intentionally omitted.

## Environment

- Date: 2026-08-25 CST (container logs use UTC).
- Client: Cursor 3.17.8 with Override Base URL.
- Ingress: public HTTPS Cloudflare Quick Tunnel to `/cursor/default/v1/chat/completions`.
- Runtime: MemoryProxy on Node.js 22 with MemoryCore and Memory Hub.
- Wire protocol: OpenAI Chat Completions with streaming and Cursor's native `AskQuestion` tool.
- Upstream: OpenAI-compatible DeepSeek endpoint using a test-only local credential.
- Observability: Langfuse Cloud; credentials are stored only in a Git-ignored local config.

## Maintainer completion checklist

| Requirement | Status | Evidence |
|---|---|---|
| First request returns a Cursor-native session-init tool call | Passed | Cursor UI displayed the first `AskQuestion` form; proxy entered `pending_asset_confirm`. |
| `asset_confirm -> team -> agent -> task` | Passed | Real UI recording and proxy state transitions through all four stages to `initialized`. |
| Main conversation reaches upstream without wire errors | Passed | Streaming responses completed; missing DeepSeek `reasoning_content` was repaired on Cursor replay and no `invalid_request_error` remained. |
| Skill, Memory, and Knowledge injection | Passed | Injection configuration contained all three injectors; runtime logs and Langfuse injection spans show Skill and Memory blocks being served, and `mem:sync` confirmed all configured asset classes. |
| `mem:help` interception | Passed | Proxy log: `[mem-command] cmd=help ... success=true`; UI recording captured the local response. |
| `mem:sync` interception | Passed | Proxy log: `[mem-command] cmd=sync ... success=true`; UI confirmed the refreshed assets. |
| `mem:create-skill` interception | Passed | Proxy log: `[mem-command] cmd=create-skill ... success=true`; UI confirmed archive submission. |
| L0 conversation archive | Passed | Proxy log contains `tdai-recorder:write-l0` for normal Cursor turns. |
| Skill archive and extraction trigger | Passed | Proxy log contains `[skill-conversation-add] archived`; MemoryCore worker completed with `outcome=ok`. |
| Normal memory recall | Passed | Real Cursor UI recalled existing L1 instructions concerning the CURSOR marker. |
| Langfuse `agent_source:cursor` | Passed | Real streaming generations show `agent_source:cursor`, `protocol:openai`, and `stream` tags. |
| Auxiliary requests bypass form/injection/archive | Not observed in this client run | No title-generation or compaction request reached the custom endpoint. Unknown non-`messages[]` shapes use the established no-side-effect auxiliary passthrough and emit a Cursor warning; unit coverage verifies this fail-open classification. A live auxiliary fixture must not be claimed until Cursor emits one. |
| Test suite | Passed for the complete discoverable suite in this checkout | 6 test files passed, 15 tests passed after boundary regression coverage was added. The checkout contains exactly those six `*.test.ts`/`*.spec.ts` files. |

## Type-check status

`npm run typecheck` still reports six errors outside the Cursor change surface:

- `anthropicHandler.ts`: the pre-existing shared `RequestKind`/`CcRequestKind` mismatch;
- `codexHandler.ts`: `RequestLogEntry.traceId` mismatch;
- `config.ts`: three missing `RawYamlConfig.memCommand` properties;
- `storage/factory.ts`: missing declaration for the private/local `@context-proxy/cost-guard` module.

The Cursor mem-command implementation originally exposed an ES target mismatch through `Array.prototype.findLast`; it was replaced with a backwards loop and its focused test passes. No remaining type-check error points to a Cursor-added file or Cursor-specific changed line.

## Non-blocking runtime warnings

- The hook cache can log a foreign-key failure for this test identity. Its prewarm/self-heal path immediately populated and served the configured Skill and Memory blocks, so the warning did not prevent injection or archiving.
- Credit reporting and optional embedding services may be unavailable in the local acceptance stack. These failures are fail-open and did not affect the Cursor request, Memory Bridge recall, L0 archive, Skill extraction, or Langfuse export.
- A Skill extraction run may finish successfully with zero candidates when the short acceptance conversation adds no reusable Skill. The required trigger and worker completion still occurred.

## Evidence package

- Cursor recording: full form, injected assets, normal conversation and memory recall, and all three mem commands.
- Langfuse screenshot: a real Cursor generation with `agent_source:cursor`; redact user and session identifiers before publication.
- Sanitized protocol fixtures: `../proxy-inbound/01-new-conversation.json` through `05-ask-question-result.json`.
- Protocol findings and option-limit result: `../README.md` and `capture-matrix.md`.
- Proxy/MemoryCore log excerpts: retain only the checklist markers above and redact identities, authorization values, local paths, and public temporary tunnel hostnames.

## Honest limitation

The temporary Quick Tunnel is acceptance infrastructure, not a production deployment recommendation. The real Cursor run did not emit a classifiable auxiliary request, so this report records that item as not observed rather than manufacturing evidence.

The confirmed Cursor Proxy ingress also supplied no conversation-specific
header. The deterministic fallback is stable for the observed conversation,
but two fresh conversations from the same account with identical first user
turns resolve to the same fallback ID. This protocol boundary is covered by a
regression test and must not be described as guaranteed cross-conversation
isolation unless Cursor later exposes a stable identifier.
