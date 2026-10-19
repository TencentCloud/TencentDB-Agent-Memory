# Verification: subscription account pool (Codex only)

Date: 2026-10-19 (Asia/Saigon). Branch `feat/subscription-account-pool`, all changes uncommitted.

## Result

The feature works end to end with real Core, real Proxy, real Panel and a mock ChatGPT backend.
With the pool off, the Proxy sends byte-identical upstream requests to the unmodified (`HEAD`)
Proxy. No token appears in logs or public responses. Not verified: real ChatGPT accounts (none
available) and the Docker stack (`start-all.sh`).

## Order of runs

The end-to-end run and the Panel admin screenshots were taken before the last review fixes. The
fixes after the end-to-end run (blank `x-tdai-user-key`, main model kept for pool requests, failed
reports sent again, auth headers dropped early for pool requests) change only pool branches and the
`trim()` of the user key header in `auth.ts`, which does nothing when the header is absent. The
Proxy suite (114 tests, including the pool-off and forwarding tests) ran again after them; the
end-to-end run was not repeated. The Panel guard was rewritten after the admin screenshots; it uses
the same `isGlobalAdmin` check as before for the admin, and the member redirect was checked again
after the change.

## Test suites

| Package | Tests | Type check |
|---|---|---|
| MemoryCore | 12 files, 133 tests pass | no new errors in touched files; `npm run build:plugin` passes |
| MemoryProxy | 12 files, 114 tests pass (after the review fixes) | 1 error, same as the baseline (`@context-proxy/cost-guard` missing) |
| MemoryPanel | 2 files, 45 tests pass | 0 errors (server and web); `vite build` passes |

## End-to-end run (real processes)

Setup: Core gateway on a temp sqlite store (pool timers off, fake tokens), pool group pointed at a
mock ChatGPT backend through its `base_url` (written straight into the temp store; the public API
rejects it), real Proxy with a minimal config (no Redis, memory storage, auth through Core),
requests sent like Codex (`POST /codex/default/v1/responses`, `session-id`).

| Scenario | Expected | Observed |
|---|---|---|
| Session s1, first turn; the mock returns 429 `usage_limit_reached` for account A | Retried once on another account before the client sees anything | Client 200; upstream calls A (429) then B (200) |
| s1 turns 2–3 | Same account | B, B |
| New session s2 while A is exhausted | Not A | B |
| Upstream request content | Pool token, `chatgpt-account-id`, `store: false`, no `x-tdai-user-key` | As expected |
| Core after the proxy reports (≤ 5 s batch) | A exhausted until the 429 reset; B windows from headers | A `exhausted` for 10 min; B `primary_window` 42 %, `secondary_window` 7 %, source `header`; 2 active sessions |
| All accounts exhausted; client sends own ChatGPT login + `x-tdai-user-key` | Forwarded with the client's own login | 200; upstream got the client's `authorization` and `chatgpt-account-id`, no user key |
| All accounts exhausted; no own login | 429 with earliest reset | 429, `retry-after` 542, `x-tdai-pool-earliest-reset` = A's reset, Codex `usage_limit_reached` body |
| Pool turned off in Core, same request to the new Proxy and to a `HEAD` Proxy | Identical upstream request | Same path `/v1/responses`, method, body and every header |
| Logs of Core and both Proxies | No token | 0 matches for pool tokens, the client login and the user key |

## Panel in a browser (real Panel + Core, seeded accounts)

- System Admin: page shows all states (Active, Near limit with a per-model row, Exhausted with
  release time, Disabled with "Usage check failing", Re-login needed), summary, settings, pool
  switch. Claude Code tab shows the not-supported notice only.
- Member: the menu item is hidden; opening `#/team/subscription-pool` redirects to `#/`;
  `subscription-pool/status` returns 403. The status response for the admin has no token values
  or token field names.
- Fixed during this check: a member without an active team saw a blank page instead of the
  redirect (the guard used the team role; it now uses the System Admin flag); the fallback warning
  said Codex cannot send its own login (outdated).
- A browser translation extension on the test machine rewrote some numbers to words in the
  screenshot ("twenty two %"); the DOM source and the bundle do not contain that text.

## GitNexus (`detect_changes`, compare with `feat/server_team`)

48 files, 212 symbols, 65 affected processes, risk critical (whole uncommitted tree). The
processes start in the expected areas only: Panel `ApiKeyPanel` and `GuidePage`; Core gateway
`start` / `doStop`, `handleV3MetaRoute`, upstream group service and store helpers. The
`*InstanceUpstreamExtraction` processes are flagged through shared store helpers; their code is
unchanged, and the only change on the existing upstream group path is the added
`subscription_pool` branch (other modes keep the same `base_url` / `api_key` checks).

## Not verified

- Real ChatGPT accounts: login (authorize URL and redirect paste), token refresh, usage API shape
  (`additional_rate_limits` rows), live 429 body.
- 401 → refresh → retry against real Core (unit-tested on both sides; the e2e Core had no real
  provider).
- Docker stack (`deploy/global-images/start-all.sh`) built from this branch. Not built: the Core and
  Proxy images copy the source tree and run it with `tsx`, which is how the real processes above
  ran; no `.dockerignore` rule excludes the new files; `start-memory-core.sh` passes the two pool
  variables (checked with `bash -n` and by reading the `docker run` line).
