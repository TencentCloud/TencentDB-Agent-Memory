---
phase: 3
title: "Core OAuth, token refresh and usage job"
status: in-progress
priority: P1
effort: "1.5d"
dependencies: [2]
---

# Phase 3: Core OAuth, token refresh and usage job

## Goal
Make Memory Core the single owner of provider tokens: exchange login codes, refresh tokens before
they expire, track quota and run timed work on in-memory timers that are rebuilt from fresh
provider data on every start ([ADR 0001](../../docs/adr/0001-proxy-side-subscription-pool.md)).

## Impact check (run first)
- `impact` upstream on: the gateway startup and shutdown path (`MemoryCore/src/gateway/server.ts:786`,
  `main` at `:3369`, SIGTERM at `:3393`), the metadata store pool that resolves per-instance stores.

## Files to Create / Modify
- Create: `MemoryCore/src/subscription-pool/providers/types.ts` — `SubscriptionProviderAdapter`:
  `buildAuthorizeUrl(state, challenge)`, `exchangeCode(input)`, `refresh(refreshToken)`,
  `fetchUsage(account)`, `parseUsage(raw)` (all windows, including per-model windows),
  `providerAccountId(tokens)`.
- Create: `MemoryCore/src/subscription-pool/providers/claude.ts` and `codex.ts` — endpoints, client
  IDs and fields exactly as recorded in the phase 0 report. Each file is the only place that knows
  that provider's URLs.
- Create: `MemoryCore/src/subscription-pool/oauth-state.ts` — PKCE verifier/state store, 10-minute
  expiry.
- Create: `MemoryCore/src/subscription-pool/quota-merge.ts` — pure function that merges a new
  observation into `usage_json`: per window the newest `observed_at` wins; a 429 sets
  `used_pct=100` until `resets_at`.
- Create: `MemoryCore/src/subscription-pool/token-refresher.ts` — per-account in-process lock.
- Create: `MemoryCore/src/subscription-pool/timer-queue.ts` — in-memory queue of
  `{accountId, instanceId, kind: "refresh" | "reset-check" | "retry-usage" | "retry-refresh", at}`
  with one `setTimeout` armed for the earliest entry. Every service write that changes a time
  (token expiry, 429, usage result) updates the queue. No DB reads after startup.
- Create: `MemoryCore/src/subscription-pool/pool-scheduler.ts` — startup, the 30-minute usage job
  and the handlers for each timer kind.
- Modify: `MemoryCore/src/gateway/server.ts` — start the scheduler after listen; clear all timers
  on shutdown.
- Modify: `MemoryCore/src/gateway/config.ts` — env `SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN`
  (default 30) and `SUBSCRIPTION_POOL_ENABLED` (default true; nothing runs when no pool account
  exists).
- Create: unit tests for provider parsers (phase 0 sample payloads, tokens redacted), quota merge,
  refresher lock, timer queue and scheduler handlers (fake timers).

## Implementation design (Codex only, decision 33)

Scope change: Claude has no adapter. The draft `providers/claude.ts` is removed and the Claude
branch leaves `metadata/subscription-pool/authorize-url.ts`. `enable`, `oauth-start` and
`oauth-complete` reject `claude` with `PROVIDER_NOT_SUPPORTED`.

- `providers/index.ts` — `subscriptionAdapterFor(provider)`; codex only.
- `account-ops.ts` — store-level operations that run under the per-account lock
  (`withAccountLock` in `token-refresher.ts`; the duplicate lock in `MetadataService` is removed):
  - `refreshAccountTokens(store, accountId, adapter, { minRemainingMs })` — re-reads inside the
    lock and skips the provider call when the token is still fresh (several 401s → one refresh).
    The token write has no version check: only the lock holder writes tokens, and a version
    conflict caused by a usage write must not drop a rotated refresh token.
  - `checkAccountUsage(store, accountId, adapter, threshold, now)` — fetch outside the lock,
    merge and write inside it; release rule of decision 30; failure counts per decision 29.
  - quota report uses `mergeUsageWindows` (newest wins, 429 wins) instead of its own merge.
- `timer-plan.ts` — pure `planAccountTimers(account, threshold, now)`: `refresh` at expiry − 10 min
  (not while `refresh_fail_count > 0`, not for `auth_error` or disabled accounts), `reset-check` at
  `exhausted_until + 30 s`, or at the earliest reset of a window at or above the threshold.
  Retry timers (`retry-refresh`, `retry-usage`) are set only by handlers after a failure.
- `pool-scheduler.ts` — owns `PoolTimerQueue`, the set of known instances and the sweep timer.
  `registerInstance(id)` runs the startup pass for a new instance (one account at a time, 1 s
  apart). `syncAccount(instanceId, account | null)` re-plans one account after any service write.
  Handlers call `MetadataService` methods so routes and timers share one code path.
- `MetadataService` — `setSubscriptionPoolHooks({ adapterFor, onAccountChanged })`; real
  implementations of `oauth-complete` (account attaches to the provider's pool group; that group
  must exist), `check-usage`, `check-all` and `refresh`.
- Gateway — create the scheduler in `start()` when `SUBSCRIPTION_POOL_ENABLED` is not `false`;
  `ensureMetadataService` registers each instance it creates; local mode registers
  `config.instanceId ?? "default"` after listen; `doStop` stops the scheduler first.

## Behavior

**Startup (every Core start or restart).** For every instance served by this Core, read the
Subscription Accounts once. For each account, one at a time about 1 s apart: refresh the token if
it has < 10 min left; call the usage API; merge the result; arm timers from the fresh reset times
and token expiry. If the usage API fails, arm timers from the DB snapshot (`usage_json`,
`exhausted_until`) and queue `retry-usage` at +1, +5, +15 min. The proxy keeps serving from the
old data during startup.

**Token refresh.**
- Timer `refresh` at `token_expires_at − 10 min` for every account, used or idle.
- Internal `refresh` route (proxy got a 401) refreshes at once under the same lock.
- Write the new token pair to the DB in the same step, before anything else.
- Transient failure (network, 5xx): `retry-refresh` at +1, +5, +15 min. While the old access token
  is valid the account keeps serving; after it expires the account gets no new sessions.
- Permanent failure (`invalid_grant`, revoked): `status = auth_error` at once (Panel: Re-login
  needed).

**Quota tracking.**
- Sources: proxy reports (headers, 429), the usage API (30-min job and timers). Merge with
  `quota-merge.ts`.
- 429 with a reset time: `exhausted_until = reset`; timer `reset-check` at reset + 30 s.
- 429 without a reset time: `exhausted_until = now + 15 min`; timer `reset-check` then.
- Usage API failure: increment `usage_fail_count`; Panel warns at 3; reset to 0 on success.

**Reset-time check (`reset-check`).** Armed at the reset time of every window, for Exhausted and
for Near-limit accounts. Call the usage API: if usage is below the Threshold, clear
`exhausted_until` and set `status = active`; if not yet reset, re-arm at +15 min; if the usage API
fails, release by time (the proxy already treats `now ≥ exhausted_until` as usable).

**30-minute job.** For every account: usage API call and merge, plus a refresh if the token has
< 40 min left. This keeps data current when Members log in directly, outside the proxy.

## Tasks & Steps
1. Run the impact check.
2. Implement adapters from the phase 0 report. Use `fetch` with `AbortSignal.timeout(10_000)`.
3. Implement quota merge and the refresher. Token writes have no `version` check: the
   per-account lock makes the refresher the only token writer, and the provider has already
   revoked the old refresh token, so the new pair must be stored (decision 24).
4. Implement the timer queue and scheduler handlers.
5. Wire `oauth-start`, `oauth-complete`, `check-usage`, `check-all` and internal `refresh` and
   `report` (phase 2 routes) to these modules.
6. Document in INSTALL (phase 6) that one Core process per instance runs the timers; several Core
   replicas need a lease first.

## Verification
- `cd MemoryCore && npx vitest run src/subscription-pool` passes.
- Fake-timer test: restart with one Exhausted account → startup usage call → timer fires at reset
  → account released; usage API down at startup → timers from DB snapshot, retries at +1/+5/+15.
- Manual: with a test account, `oauth-start` → login → `oauth-complete` creates an account;
  `check-usage` fills `usage_json`; forcing `token_expires_at` near now triggers one refresh.
- Logs contain no token (`grep -E "eyJ|sk-ant-|refresh_token" core.log` returns only key names).

## Risk / rollback
- Provider changes break only the adapter file; the proxy still works on headers and 429.
- Set `SUBSCRIPTION_POOL_ENABLED=false` to stop all timers without a code change.

## Results (2026-10-19)

Codex only (decision 33). Claude adapter draft removed; `claude` returns `PROVIDER_NOT_SUPPORTED`.

- Tests: `npx vitest run` in MemoryCore — 12 files, 131 tests pass (new: providers/codex,
  quota-merge, timer-plan, timer-queue, token-refresher, usage-check, pool-scheduler,
  api-sanitize; service test moved to `codex`).
- Fake-timer scheduler tests cover: restart with an Exhausted account → released at reset;
  usage API down at startup → timers from the DB snapshot, retries at +1/+5/+15, release by time;
  refresh 10 min before expiry; 30-minute pass with refresh below 40 min; deleted account.
- Gateway smoke test (real process, temp sqlite, no provider calls): scheduler registers the
  local instance with its 30-minute pass; `enable claude` → 400; `enable codex`, `oauth-start`,
  `check-all` work; `stop()` clears all timers and the process exits.
- Found and fixed beyond the plan: API trace logged top-level string fields of a traced
  argument without redaction, and `access_token` / `refresh_token` were not sensitive keys; the
  first reachable token write (account upsert) would have put tokens into trace logs.
- Not verified: a real Codex login, refresh and usage call (needs a test account). The manual
  check in Verification stays open.
- Type check: no new errors in touched files; remaining errors are older (see baseline report).
- Service mode: an instance starts its timers on its first metadata request after a restart.

### Code review fixes (report: `plans/reports/code-reviewer-261019-1456-subscription-pool-core-timers.md`)

Fixed, each with a test:
- Reset-check loop (critical, about 2,700 usage calls in 35 s in the reviewer's repro, 1 call after
  the fix): a stored window that the usage API no longer returns and whose reset has passed is
  dropped; an exhaustion time is never set in the past.
- A 429 report no longer changes `auth_error` or `disabled`; a report without a 429 writes no status
  or exhaustion, so it cannot undo a Panel change. Panel updates and re-logins run under the
  per-account lock, so a running refresh cannot overwrite a new login.
- A refresh response without `access_token` keeps the stored token and expiry. Only a 401 or a
  known code (`invalid_grant`, `refresh_token_*`) is a permanent refresh failure; a bare 400 is
  transient.
- `check-all` skips `auth_error` and `disabled` accounts. A failing scheduler hook no longer fails a
  committed write. A refresh that failed before a restart runs again at startup. Scheduler timers
  run without the HTTP request's trace context. Malformed pasted URL → `INVALID_OAUTH_CODE`.
  Extra Codex limit rows without a usage percent are skipped. Timer delay capped at 2^31−1 ms.

Not changed (low, documented): usage fail counts stored before a restart (3 or more) get no fast
retries after it, only the 30-minute pass; transient refresh failures keep retrying every 15 min
while the old token serves; a write that finishes just before a delete can re-arm timers once.

Open question for Phase 5: the account `status: "disabled"` field and the `enabled` switch are two
admin switches (Phase 2 schema). Pick one before the Panel uses them.
