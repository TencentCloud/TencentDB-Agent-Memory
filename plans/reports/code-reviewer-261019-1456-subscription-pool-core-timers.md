# Code review: subscription pool core (OAuth, refresh, usage, timers)

Date: 2026-10-19 (Asia/Saigon). Scope: uncommitted MemoryCore changes listed in the task. Read-only review.
Tests: `npx vitest run src/subscription-pool src/metadata src/api-trace` -> 12 files, 115 tests pass.
Repro scripts (scratchpad, tsx, real sqlite in-memory, real scheduler): `loop.mts`, `status.mts`, `overflow.mts`.

## Confirmed findings

### C1 (critical) Reset-check hot loop on a stale window that the usage API no longer returns
- Files: `src/subscription-pool/usage-check.ts:74-83`, `src/subscription-pool/timer-plan.ts:25-32`, `src/metadata/subscription-pool/quota-report.ts:37-43`.
- Cause: on an exhausted account, `limitedResets` is computed from the MERGED windows (`current` + reading). `withNextCheck` moves a past reset to `now + 15 min` only for windows in the fresh reading. A window that is in `current` but not in the reading (proxy header window with another name, e.g. `primary` vs `primary_window`; a `secondary_window` that the API now returns as null - the spike says windows may be null; an additional limit that disappeared) keeps `used_pct = 100` (the 429 path sets every window to 100 / source 429) and a past `resets_at`. Then `exhausted_until = min(...)` = a past time, status stays `exhausted`, `syncAccount` plans `reset-check` at `max(now, past + 30 s)` = now, the queue fires at once, and the cycle repeats.
- Repro (`loop.mts`): report window `primary` 50 %, then 429 with `retry_after: 1`; usage API returns only `primary_window` 10 %. Result: **2697 usage API calls in 35 s**, status stays `exhausted`, `exhausted_until` 34 s in the past. This is a hammering loop against `chatgpt.com/backend-api/wham/usage` (account ban risk) and a DB write per iteration. It also contradicts decision 30 (release when below threshold).
- Trigger without any name mismatch: spike 5.4 says `secondary_window` may be null. A 429 sets a previously seen `secondary_window` to 100 %; the next reading omits it; loop.
- Fix: after the merge, DISCARD windows that the reading did not refresh and whose `resets_at <= now` (in particular `source === "429"` holds that expired). Do not "bump" them to `now + 15 min`: a bumped phantom window re-exhausts the account every 15 min forever (the same loop, slower). Then compute `limitedResets` only from windows with `resets_at === null || resets_at > now`. Defense in depth: in `planAccountTimers`, never plan a `reset-check` at `now` for a `resetAt` already in the past (use `now + RECHECK_MS`).
- Test gap: add a scheduler test with a stale window absent from the reading and assert `fetchUsage` call count stays bounded and the account is released.

### C2 (high for auth_error, medium for disabled) A 429 report overwrites `disabled` / `auth_error`; the reset check then sets `active`
- Files: `src/metadata/subscription-pool/quota-report.ts:46` (`status: is429 ? "exhausted" : current.status`), `src/subscription-pool/usage-check.ts:62,80` (`exhausted` -> `active`).
- Scenario (`status.mts`, confirmed): admin sets `status: "disabled"` (schema allows it, `v3-meta-schemas.ts:470`); an in-flight proxy request on that account gets 429 and reports; status becomes `exhausted`; the reset check releases it to `active`. Output: `after 429 on disabled: exhausted`, `after usage check: active`. The admin's disable is silently reverted. Same for `auth_error` (decision 23 "auth_error at once"): it becomes `exhausted`, then `active`, the proxy can hand out an account with a dead refresh token (decision 31 treats a passed `exhausted_until` as usable).
- Severity split: the `auth_error` leg is unambiguous (high). The `disabled` leg depends on which admin switch is authoritative: the sqlite/mongo upsert derives status from `enabled`, which suggests `enabled` is the switch and `status: "disabled"` in the update schema is a second, inconsistent path. If `enabled: false` is used, the proxy still excludes the account and this leg is medium.
- Fix: in `applyQuotaReport`, set `status: "exhausted"` only when `current.status` is `active` or `exhausted`; otherwise keep the status and only record `exhausted_until`/usage. Also decide one admin switch: remove `status` from `subscriptionPoolAccountUpdateSchema` or make every writer respect `status: "disabled"`. Add tests for 429 on `disabled` and `auth_error`.

### C3 (high) Re-login write is a second token writer outside the per-account lock; an in-flight refresh overwrites the new login
- Files: `src/metadata/service/metadata-service.ts:2536` (`upsertSubscriptionAccountByProviderId` not under `withAccountLock`), `src/subscription-pool/token-refresher.ts:90-98` (no version check).
- The accepted design says "only the lock holder writes tokens". That is not true: `completeSubscriptionOAuth` writes tokens without the lock. Scenario (`status.mts`, confirmed): a `retry-refresh` or proxy-401 refresh is waiting on the provider (up to 10 s); the admin completes a re-login; the refresh then returns and writes the token pair from the OLD refresh-token family over the fresh login. Output: `after relogin: R-relogin`, `after in-flight refresh: A-from-old-rt R-from-old-rt`. If the old RT was revoked by the re-login, the in-flight refresh instead fails permanently and writes `auth_error` + "re-login needed" right after a successful re-login.
- Fix: run the upsert under `withAccountLock(existingAccountId, ...)` (look up the existing row by provider id first), or in `refreshAccountTokens` re-read the row after the provider call and skip the write (return the stored row) when `refresh_token` changed since `current` was read. The second option also covers any future writer.

### C4 (medium) Refresh response without `access_token` stores an empty token and a null expiry
- Files: `src/subscription-pool/providers/codex.ts:92-102`, `src/subscription-pool/token-refresher.ts:90-93`.
- Spike 5.2: refresh response fields `id_token?`, `access_token?`, `refresh_token?` are all optional; "each present field replaces the stored one". The code keeps the old refresh token when missing but always writes `access_token: next.accessToken` (`""` when absent) and `token_expires_at: next.expiresAt` (null, since the JWT is empty). Store `setColumn` writes `""` (only `undefined` is skipped). Result: proxy gets an empty bearer; planner never plans `refresh` (expiry null); sweep skips it ("unknown expiry is not refreshed"). Only a proxy 401 recovers it.
- Fix: treat a missing access token as "keep stored" (`access_token: next.accessToken || undefined`, `token_expires_at` only when a new access token was returned), or treat a 200 without `access_token` as a transient failure. Add a codex.test case.

### C5 (medium) Any HTTP 400 on refresh is classified permanent -> immediate `auth_error`
- File: `src/subscription-pool/providers/types.ts:63` (`permanent = status === 400 || status === 401`), also `invalid_request` in the permanent set (line 56).
- Spike 5.2: permanent = 401, or 400 with `invalid_grant`, or the three `refresh_token_*` codes; other errors are transient. A 400 from a WAF/edge, a body-format change, or `invalid_request` puts a healthy account into "Re-login needed" at once (decision 23 says transient errors retry 1/5/15).
- Operational failure: `invalid_request` on refresh almost always means a malformed request body, i.e. a Core deploy bug, not a dead RT. With the current rule, one bad deploy marks every account `auth_error` and forces N manual re-logins.
- Fix: `permanent = status === 401` by default; set permanent for 400 only when the body code is in the set; remove `invalid_request` unless a source shows it means a dead RT.

### C6 (medium) Panel account update is not under the account lock; report/usage writes revert it
- Files: `metadata-service.ts:2446` (no lock), `quota-report.ts:46-49` (report always writes `status` and `exhausted_until` from the row read inside its lock).
- Scenario: panel PATCH `status: "disabled"` lands between the report's read and write; the report writes the stale `status: "active"` back. Narrow on sqlite (one await gap), real on MongoDB (two round-trips). Fix: run `updateSubscriptionAccount` under `withAccountLock`, and have `applyQuotaReport` return `status` / `exhausted_until` only when they change.

### C7 (medium) Scheduler timers inherit the AsyncLocalStorage request context of whoever last armed the queue
- Files: `src/subscription-pool/timer-queue.ts:58` (single `setTimeout` created inside `arm()`), called from `syncAccount` during HTTP routes (report, refresh, panel update).
- Node `setTimeout` captures the current ALS store. After any route re-arms the queue, every due timer, for every instance, runs inside that request's `ApiRequestContext` (`requestId`, `instanceId`). `wrapAsyncMethod` then logs scheduler service/store calls (`api.service.enter/exit`) under a finished request id and possibly another tenant's `instance_id`. No token leaks (args redacted), but traces are mis-attributed across instances.
- Fix: create the queue timer outside the request context, e.g. `apiRequestStorage.exit(() => setTimeout(...))` in the default `schedule`, or wrap `onDue` with `AsyncResource.bind` created at scheduler construction.

### C8 (low) Persisted fail counters skip the startup retries of decision 26
- File: `metadata-service.ts:2562`. `failCount` is the cumulative DB value. An account that already had 3+ usage failures before a restart gets no `retry-usage` at +1/+5/+15 after the startup failure; one with count 1 starts at +5 min. Decision 26 asks for 1/5/15 at startup. Fix: count retries per process (scheduler-side attempt counter) or reset `usage_fail_count` semantics for the startup pass.
- Related (narrow path): a proxy-401 refresh (`refreshSubscriptionAccount`) on a long-lived token fails transiently -> `refresh_fail_count = 1`, `retry-refresh` at +1 min; Core restarts before it fires. After the restart, the startup pass skips it (> 10 min left), the planner skips it (fail count > 0) and no handler re-arms `retry-refresh`. Only the sweep refreshes it once < 40 min are left, which works only while `SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN < 40` (the env value is unbounded above). (A failure from the timer path is still retried by the startup pass because the token is then within 10 min of expiry.) Fix: in `pass(..., armFromSnapshot)` arm `retry-refresh` at now for accounts with `refresh_fail_count > 0`, or clamp the interval.

### C12 (medium) `check-all` runs on `auth_error` / `disabled` accounts and bursts the usage API inside one request
- File: `metadata-service.ts:2589-2600`. It filters only `!enabled` and unsupported providers. (a) On an `auth_error` account the dead token gets 401, `usage_fail_count` grows and `last_error` "re-login needed" is overwritten with "usage check failed" (the Panel loses the reason). (b) It checks every account serially with no gap inside one HTTP request, each call up to a 10 s timeout: one Panel click is a burst against `wham/usage` and a request that can run for minutes.
- Fix: apply the same filter as `pass()` (skip `disabled` / `auth_error`), add the account gap, or make the route start a detached job and return at once.

### C13 (low) Notify failure after a committed write loses the timer and fails the route
- File: `metadata-service.ts:2430-2434`. `notifySubscriptionAccount` awaits `subscriptionThreshold()` after the store write. If the config read throws, the route returns an error although the write is committed (for `refresh` the proxy sees a failed refresh after a successful rotation), and `syncAccount` never runs, so that change's timer is lost until the sweep. Fix: read the threshold before the write, or catch and log around the listener so a notify failure never masks a committed write.

### C9 (low) Transient refresh failures retry every 15 min forever with an unbounded counter
- File: `token-refresher.ts:29-32,79-85`. After the third failure, every retry stays at 15 min and `refresh_fail_count` grows without bound. Decision 23 lists 1/5/15 only. Probably acceptable (the sweep would retry anyway), but confirm the intended behavior after the third failure.

### C10 (low) `SubscriptionAccountWriteConflictError` uses `reason`, not `code`, so the scheduler's `account_not_found` cleanup misses it
- Files: `pool-scheduler.ts:31-35,157`, `usage-check.ts:44,55`, `metadata-service.ts:2554-2565` (no `translateSubscriptionConflict` in `runSubscriptionUsageCheck`). An account deleted during a usage fetch logs `error=SubscriptionAccountWriteConflictError` instead of being treated as gone. Timers are already removed by the delete notify, so the impact is a misleading warn. Fix: translate in `runSubscriptionUsageCheck` or read `reason` in `errorCode`.

### C11 (low) `parseSubscriptionOAuthCode` throws a raw `TypeError` on a malformed `http...` paste
- File: `authorize-url.ts:55-57`. `new URL(raw)` throws -> generic 500 instead of `INVALID_OAUTH_CODE`. Fix: try/catch -> `{ code: "" }`.

## Speculative findings (need provider data or later-phase confirmation)

- S1 (medium) `parseCodexUsage` `additional_rate_limits` shape (`codex.ts:68-76`): code reads `row.primary_window ?? row` and `row.model`. If the real row is `{limit_name, metered_feature, rate_limit: {primary_window, secondary_window}}`, every additional limit parses as a phantom 0 % window with `model_scope: null` (treated as a shared window), and real per-model limits are lost. If they are ever parsed at 100 %, a model-specific limit would mark the whole account exhausted. Verify against `codex-backend-openapi-models` before Phase 4.
- S2 (medium) Refresh loop when a provider token lives less than `REFRESH_LEAD_MS` (10 min) or the Core clock runs >10 min ahead of the JWT `exp`: `refresh` timer at `max(now, exp - 10 min)` = now after every successful refresh -> continuous refresh calls on a rotating single-use RT. Codex tokens live for days (spike 5.2), so unlikely; a floor (`at >= now + 1 min` after a successful refresh) removes the risk.
- S3 (low) Ghost timers after delete: a write that completes just before a delete can notify after the delete's `account: null` notify (both await `subscriptionThreshold()`), re-arming timers for a deleted account. Self-heals on the next fire (`account_not_found` removes them).
- S4 (low) Sweep overlap: `armSweep` runs before `pass`, so a pass that takes longer than the interval (about 85+ accounts with a failing provider: 1 s gap + 2 x 10 s timeouts) overlaps the next one and doubles provider load.
- S5 (low) `setTimeout` overflow: if `SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN` > 35791 (about 24.8 days), the earliest queue entry exceeds 2^31-1 ms, Node fires after 1 ms, and the queue re-arms every 1 ms (CPU spin, no provider calls because of the due filter; verified with `overflow.mts`, retry_after 30 days does not spin while the sweep is earlier). Clamp the wait to 2^31-1 in `arm()`.
- S6 (low) Trace masking keeps the first 8 characters of a token (`maskKeyValue`), and a token of 8 characters or fewer is logged in full. Fine for JWT access tokens (constant header); review if Codex refresh tokens have a short random prefix.

## Checked and found correct
- Token exposure: `toPublicSubscriptionAccount` omits tokens; scheduler logs only error codes; code-exchange failures log `e.name`; `summarizeArgs` now redacts sensitive keys; response bodies go through `sanitizeApiPayload` (masked); `last_error` uses constants. Tokens are returned only by internal routes (`accounts/list`, `refresh`).
- Detached promises: `registerInstance` (`server.ts:555`), queue `onDue` -> `run` and `pass` catch all errors; `startSubscriptionPoolForLocalInstance` has `.catch`. No unhandled rejection path found.
- `stop()`: queue cleared, `upsert` after stop is a no-op, `pass` checks `stopped` between accounts; `doStop` stops the scheduler first.
- Release by time on usage failure (decision 30) and 429-without-reset fallback 15 min (decision 28) behave as specified for the single-window case (existing tests).

## Test gaps
- No test for windows present in `current` but absent from the reading (C1).
- No test for 429 report on `disabled` / `auth_error` (C2).
- No concurrency test: re-login vs in-flight refresh (C3); panel update vs report (C6).
- No codex test for refresh body without `access_token` (C4) or 400 without `invalid_grant` (C5).
- No restart test with persisted `usage_fail_count >= 3` or `refresh_fail_count > 0` (C8).

## Unresolved questions
- Intended behavior after the third transient refresh failure (C9)?
- Real shape of `additional_rate_limits` rows (S1)?
- Will Phase 4 report windows with the usage API names (`primary_window` / `secondary_window`)? C1 triggers either way when the API omits a window, but name alignment lowers its frequency.
