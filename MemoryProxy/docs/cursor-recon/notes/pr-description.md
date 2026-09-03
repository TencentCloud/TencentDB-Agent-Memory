# Cursor Proxy Adapter

## Summary

This revision changes #1138 from the original Cursor Hooks + MCP sidecar experiment to the maintainer-requested proxy-based integration. Cursor now shares MemoryProxy's session initialization, system-prompt injection, memory/Skill/Knowledge assets, conversation archive, mem commands, and Langfuse observability path with the existing clients.

The original sidecar implementation has been removed from the proposed upstream diff. Its design remains part of the PR discussion history and can be retained separately in the contributor fork for Cursor Free/Auto research.

## Protocol reconnaissance

Five sanitized real Cursor requests are included under `MemoryProxy/docs/cursor-recon/proxy-inbound/`.

Confirmed findings:

- Cursor's custom endpoint uses OpenAI Chat Completions with `messages[]`, `tools[]`, streaming, and `stream_options.include_usage`.
- No stable conversation-specific HTTP header was observed. The adapter derives a stable fallback from the account-scoped root `user` plus the first content-block user message.
- The fallback cannot distinguish two fresh conversations from the same account when their complete first user turns are identical; this is documented as a protocol limitation rather than guaranteed isolation.
- Cursor's native UI tool is `AskQuestion` with `questions[].{id,prompt,options,allow_multiple}` and `options[].{id,label}`.
- Cursor displayed ten explicit options plus `Other...`; pagination is not needed for the current four-stage form.
- Cursor replays assistant tool calls without DeepSeek's non-standard `reasoning_content`; the adapter repairs that field without overwriting real reasoning content.

The Free IDE-side Connect/Protobuf capture is explicitly documented as non-authoritative for Proxy ingress.

## Implementation

- Adds the Cursor agent adapter, type/factory registration, and all Cursor route variants.
- Adds stable conversation fallback and Cursor first-frame metadata handling.
- Reuses the shared CodeBuddy state machine for `asset_confirm -> team -> agent -> task` and renders Cursor-native `AskQuestion` calls.
- Adds headless bypass and unknown-shape fail-open passthrough with a sanitized warning.
- Repairs missing `reasoning_content` on Cursor assistant tool-call replay.
- Makes mem-command parsing robust to Cursor's replay ordering and multi-block user content.
- Adds Cursor-aware Memory/Skill Bridge session-key candidates.
- Uses Cursor-only PowerShell-native `Invoke-RestMethod` guidance for injected bridge tools, leaving existing clients' injected instructions unchanged.
- Preserves existing non-Cursor mem parsing and bridge lookup precedence; the shared CodeBuddy state-machine branches are gated by `agentSource === "cursor"`.
- Removes the superseded Cursor sidecar files from the upstream change.

## Real E2E result

Tested with a real Cursor client through a public HTTPS endpoint and the full MemoryProxy/MemoryCore stack:

- Full session-init UI flow completed.
- Normal streaming upstream conversation completed.
- Skill, Memory, and Knowledge injection executed.
- Normal L1 memory recall succeeded in Cursor.
- `mem:help`, `mem:sync`, and `mem:create-skill` were intercepted successfully.
- Proxy emitted `tdai-recorder:write-l0`.
- Proxy emitted `[skill-conversation-add] archived`; the worker finished with `outcome=ok`.
- Langfuse received real generations tagged `agent_source:cursor`.

The real run did not emit title-generation or compaction traffic to the custom endpoint. Unknown non-chat shapes are covered by the fail-open auxiliary path, but no live auxiliary fixture is claimed.

## Tests

Executed in the project's Node.js 22 runtime:

```text
Test Files  6 passed (6)
Tests       15 passed (15)
```

The complete discoverable suite passes after adding boundary regression coverage. The Cursor flow integration test uses a per-run conversation anchor so a persistent dev session store cannot pollute repeat runs.

`npm run typecheck` still reports six pre-existing errors in the Anthropic/Codex/config/storage surfaces. The Cursor-introduced ES target mismatch found during this work was fixed; no remaining type-check error points to a Cursor-added file or Cursor-specific changed line. See `notes/e2e-acceptance.md` for the exact list.

## Evidence

- [ ] Attach the sanitized Cursor UI recording: session-init, assets, normal recall, and mem commands.
- [ ] Attach the Langfuse screenshot showing `agent_source:cursor` (blur user/session identifiers).
- [x] Sanitized Proxy-ingress fixtures and protocol matrix are included in the repository.
- [x] The E2E checklist and known non-blocking warnings are documented in `notes/e2e-acceptance.md`.

## Deployment note

Cloudflare Quick Tunnel was used only for temporary acceptance. Production use requires a stable publicly reachable HTTPS endpoint. No tunnel hostname, API key, account identifier, or local absolute path is included in the committed artifacts.
