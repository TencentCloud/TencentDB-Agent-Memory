---
phase: 0
title: "Spike: verify provider behavior"
status: in-progress
priority: P1
effort: "1d"
dependencies: []
---

# Phase 0: Spike — verify provider behavior

## Goal
Prove with real test accounts that the design works before any production code changes, and
record the exact endpoints, parameters and headers the later phases use.

## Files to Create / Modify
- Create: `plans/261019-1126-subscription-account-pool/reports/spike-261019-provider-verification.md`
- Create (throwaway, not committed to product code): `plans/261019-1126-subscription-account-pool/spike/` scripts

## Tasks & Steps
1. **Claude OAuth login flow.** Record authorize URL, token URL, client ID, scopes, PKCE method,
   redirect URI (the page that shows a code), token lifetime, refresh response shape, and whether
   a refresh rotates and revokes the old refresh token.
2. **Claude request through the proxy with memory injection on.** Run MemoryProxy locally with
   `claude-code` in mode `custom_passthrough`. Log in Claude Code with a test account and send a
   prompt. Confirm Anthropic accepts the request when injectors append to the system message
   (`MemoryProxy/src/injection/pipeline.ts:386-430`). Record required headers
   (`anthropic-beta`, `user-agent`, `x-app`).
2b. **Claude pool layout (the main path).** Configure Claude Code in API-key mode
   (`ANTHROPIC_AUTH_TOKEN=sk-mem-…`, so the client sends no OAuth header and no OAuth beta flag).
   In a throwaway proxy patch, replace `authorization` with a test account's OAuth access token,
   add the OAuth `anthropic-beta` flag, keep memory injection on, and send a prompt. Record every
   header the proxy had to add or change for Anthropic to accept the request.
   **Gate (covers 2 and 2b):** if Anthropic rejects either layout, stop and report to the user
   before phase 1.
3. **Claude rate-limit headers.** Record the `anthropic-ratelimit-unified-*` headers on a normal
   response and the body + headers of a 429 (status, reset time, window name).
4. **Claude usage endpoint.** Call `GET https://api.anthropic.com/api/oauth/usage` with
   `anthropic-beta: oauth-2025-04-20`. Record the response shape (`five_hour`, `seven_day`,
   others such as per-model weekly windows) and whether the call consumes quota.
5. **Codex OAuth login flow.** Record authorize URL, token URL, client ID, scopes, PKCE, redirect
   URI (`http://localhost:1455/auth/callback`), how `chatgpt-account-id` is derived (ID token
   claim), token lifetime and refresh rotation.
6. **Codex model request.** Record the ChatGPT backend URL for Responses
   (`https://chatgpt.com/backend-api/codex/responses` expected), required headers
   (`authorization`, `chatgpt-account-id`, `originator`, `session_id`), and the request-body
   differences from `api.openai.com/v1/responses`.
7. **Codex client OAuth to the proxy.** Check whether Codex CLI can send its own ChatGPT token to a
   custom base URL (`chatgpt_base_url`, provider `requires_openai_auth`). Record the result. If it
   cannot, the client-OAuth fallback applies to Claude Code only.
8. **Codex rate-limit headers and usage endpoint.** Record `x-codex-*` headers, the
   `usage_limit_reached` error, and `GET https://chatgpt.com/backend-api/wham/usage`.
9. **Session IDs.** Confirm Claude Code sends `x-claude-code-session-id`
   (`MemoryProxy/src/identity.ts:436`) and Codex sends `session-id` or
   `client_metadata.session_id` (`MemoryProxy/src/pipeline/runners/codex.ts:188-205`) on every
   request of one session.
10. Write the report: one table per provider (endpoint, method, headers, body, response fields),
    sample payloads with tokens replaced by `[redacted]`, and a list of design changes, if any.

## Verification
- The report exists and answers steps 1–9, including 2b.
- The step 2 / 2b gate passed, or the user has decided how to continue.
- No token, cookie or account e-mail appears in the report or in committed files
  (`git diff --cached | grep -iE "eyJ|sk-ant|refresh_token"` returns nothing).

## Risk / rollback
- Spike only. No product code changes. Delete `spike/` after phase 7.

## Results (2026-10-19)

Desk research done: [reports/spike-261019-provider-verification.md](./reports/spike-261019-provider-verification.md).
It led to decision 33 (Codex only). The live checks with real test accounts were not run; they are
the open manual acceptance check listed in phase 7.
