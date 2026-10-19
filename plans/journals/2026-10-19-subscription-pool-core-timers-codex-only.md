---
title: "Subscription pool core timers, Codex only"
date: 2026-10-19
summary: "Phase 3: Codex OAuth, token refresh, usage checks and in-memory timers in Memory Core; Claude dropped after the spike"
---

# Subscription pool core timers, Codex only

## What happened

- The spike showed that Anthropic's published policy forbids storing or intermediating Claude.ai subscription tokens, and that Claude pooling needs a client impersonation layer. The user chose Codex only (decision 33). The Claude adapter draft was removed, and `claude` now returns `PROVIDER_NOT_SUPPORTED`.
- Built test-first in `MemoryCore/src/subscription-pool/`: Codex adapter, quota merge, timer planner, timer queue, token refresher, usage check and pool scheduler. These are wired into `MetadataService` and the gateway lifecycle.
- The advisor found four defects in the earlier drafts:
  - The 401 refresh was skipped while the token still had time left, which loops forever on a revoked token.
  - The merge froze a window at 100 %.
  - A throwing handler stalled the timer queue.
  - A version conflict during refresh dropped a rotated refresh token.
- Codex refresh responses usually have no `expires_in`, so the expiry now comes from the JWT `exp` claim.
- The API trace logged top-level string arguments without redaction, and `access_token` / `refresh_token` were not sensitive keys. This would have leaked tokens on the first account upsert. Fixed in `api-traced-proxy.ts` and `api-sanitize.ts`.
- The code review found a critical reset-check loop: a stored 429 window that the usage API no longer returned caused 2,697 usage calls in 35 s. After the fix it makes 1 call.
- The review also found and the fixes now cover:
  - A 429 report changed the status of `auth_error` and `disabled` accounts.
  - A re-login during a refresh lost the new tokens.
  - A refresh response with no access token stored an empty token.
  - A bare 400 was treated as a permanent failure.
  - Timers took on the request's trace context.

## Decision

- Codex only (decision 33).
- Token writes skip the version check; the per-account lock makes the refresher the only token writer.
- Timers follow from the stored account state; retries are set only after a failure.

## Evidence

- MemoryCore `npx vitest run`: 12 files and 133 tests pass.
- The reviewer's repro scripts pass.
- Gateway smoke test: the scheduler starts and stops with no open handles.

## Next steps

- Live check with a real Codex test account: login, refresh and usage.
- Pick one admin switch, `status: "disabled"` or `enabled`, before Phase 5.
- Confirm the row shape of `additional_rate_limits`.
- Phase 4 proxy work: the inputs are recorded in the phase-04 file.
- Nothing is committed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
