---
phase: 4
title: "Proxy account selection and forwarding"
status: completed
priority: P1
effort: "2d"
dependencies: [2, 3]
---

# Phase 4: Proxy account selection and forwarding

## Goal
For agents in a `subscription_pool` group, pick an account per session, inject its token, read
quota signals, move to another account on limit, and fall back as decided. All other agents keep
today's path.

## Impact check (run first)
- `impact` upstream on: `resolveForAgent` (`MemoryProxy/src/instance-upstream-cache.ts:201`, risk
  LOW, 3 direct callers), `stageInstanceUpstreamEarly`
  (`src/pipeline/stages/instance-upstream-early.ts:50`), `stageInstanceUpstreamResponses`
  (`src/pipeline/stages/instance-upstream-responses.ts:62`), `runUtilityPipeline`
  (`src/pipeline/runners/utility.ts:89`), anthropic `buildUpstreamHeaders`
  (`src/pipeline/runners/anthropic.ts:372`), codex `buildUpstreamHeaders` (`runners/codex.ts:268`)
  and `forwardToUpstream` (`runners/codex.ts:989`), `extractApiKeyFromContext`
  (`src/pipeline/stages/auth.ts:56-75`), `src/auth.ts:60-62`.

## Files to Create / Modify
- Modify: `MemoryProxy/src/pipeline/stages/auth.ts` and `MemoryProxy/src/auth.ts` — if header
  `x-tdai-user-key` is present, it is the user key, and `Authorization` / `x-api-key` stay as the
  client's own credentials; if absent, behavior is unchanged.
- Modify: `MemoryProxy/src/instance-upstream-cache.ts` — `UpstreamMode` adds `subscription_pool`;
  `resolveForAgent` returns `{kind: "pool", row}` for an enabled custom group in that mode.
- Create: `MemoryProxy/src/subscription-pool/account-cache.ts` — fetch
  `/v3/internal/meta/subscription-pool/accounts/list` with the same TTL and stale-on-error rules
  as `instance-upstream-cache.ts`.
- Create: `MemoryProxy/src/subscription-pool/selector.ts` — pure function
  `selectAccount(accounts, binding, now, thresholdPct, requestedModel)`: an account is eligible
  when enabled, `status=active`, `now ≥ exhausted_until` (release by time even if a Core timer
  was missed), every shared window and the window of the requested model below the threshold.
  Keep the bound account while eligible; else next eligible by plain round-robin cursor (all
  accounts are Max 20x, no weighting); else lowest usage among accounts that are not Exhausted;
  else `null`.
- Create: `MemoryProxy/src/subscription-pool/binding-store.ts` — `session → account_id` and the
  round-robin cursor in **ProxyStorage** (`src/storage/proxy-storage.ts`; sqlite in the default
  deploy); first write with `putJSONIfAbsent` so two concurrent first requests create one binding;
  binding expires after **2 days** without requests. One proxy replica in v1. Key: instance +
  client type + session id (Claude: `x-claude-code-session-id`; Codex: `session-id` /
  `client_metadata.session_id`; no session id → user key).
- Modify: the model gate stage (`MemoryProxy/src/pipeline/stages/model-gate.ts:42-60`) — treat
  kind `pool` like a custom upstream (`isCustomUpstream = true`): no pricing-table gate, no alias
  rewrite; the client's model name is forwarded unchanged.
- Modify: `MemoryProxy/src/clickhouse.ts:52-99` — optional `subscription_account_id` column on the
  usage row, filled for pool requests.
- Create: `MemoryProxy/src/subscription-pool/quota-signals.ts` — parse provider rate-limit
  headers and 429 bodies (names from the phase 0 report) into `{windows[], resetAt}`.
- Create: `MemoryProxy/src/subscription-pool/reporter.ts` — send `report` to Core when a window
  changes by ≥ 1 %, on 429/401, and when a session binds to or leaves an account (so the Panel
  "Sessions" column stays current); batch at most once per 5 s per account; never blocks the
  response.
- Modify: `MemoryProxy/src/pipeline/stages/instance-upstream-early.ts` and
  `instance-upstream-responses.ts` — on kind `pool`, call the selector and return the chosen
  account; for Claude set `target.authHeaders` (`authorization: Bearer <token>`,
  `anthropic-beta` with the OAuth flag) — the hook already exists in `buildUpstreamHeaders`
  (`anthropic.ts:372-410`); for Codex return `overrideUrl` (ChatGPT backend) and `headerUpdates`
  with `authorization` and `chatgpt-account-id`.
- Modify: `MemoryProxy/src/pipeline/stages/instance-upstream-responses.ts` — for kind `pool` set
  `skipCreditReport: true`, like override groups, so pool traffic is not reported as TokenHub
  credit.
- Modify: `MemoryProxy/src/pipeline/runners/utility.ts:89` (`runUtilityPipeline`, aux routes such as
  `count_tokens` and `/v1/models`) — for kind `pool` use the session's bound account if one exists,
  else any eligible account; never create or change a binding.
- Modify: `MemoryProxy/src/pipeline/runners/anthropic.ts:1190-1200` — the retry path builds its own
  headers and forces the default upstream key; for pool requests it must keep the chosen
  account's auth headers (or re-select on 429), not the global key.
- Modify: `MemoryProxy/src/pipeline/runners/codex.ts:268-284` — do not overwrite `authorization`
  with `config.upstream.apiKey` when header updates already set it.
- Modify: runners `anthropic.ts` and `codex.ts` at the point where the upstream status and headers
  are first available (before streaming to the client): on 429 mark the account exhausted in the
  local cache, report, re-select and retry once; on 401 call internal `refresh`, retry once; on
  success parse headers and report.
- Create: `MemoryProxy/src/subscription-pool/exhausted-response.ts` — build the 429 response per
  protocol (Anthropic error JSON; Codex error JSON) with `retry-after`,
  `x-tdai-pool-status: exhausted`, `x-tdai-pool-earliest-reset`.
- Modify: `MemoryProxy/v3-api-memoryproxy-doc.md`, `MemoryProxy/README.md` — new header and mode.
- Create: tests for selector, binding store, quota parsing, auth precedence, and runner
  integration with a mock upstream (extend `MemoryProxy/scripts/qa/mock-core.mjs` with a pool row).

## Fallback order (decision 7)
1. Bound account, if eligible (enabled, active, below threshold, not exhausted).
2. Next eligible account by round-robin (new binding).
3. Account with the lowest usage that is not exhausted (above threshold is allowed).
4. Client's own `Authorization` if the request used `x-tdai-user-key` (Claude Code; Codex only if
   phase 0 confirms it).
5. 429 with the earliest reset time.

## Tasks & Steps
1. Run the impact check; warn the user on HIGH/CRITICAL.
2. Auth precedence change first, with tests proving the old header layout still works.
3. Resolution kind `pool` and account cache.
4. Selector + binding store (pure, fully unit-tested).
5. Header injection per protocol.
6. Signals, reporter, retry on 429/401 (retry only before the first byte is sent).
7. Exhausted response.
8. Run the full Proxy test suite.

## Verification
- `cd MemoryProxy && npx vitest run` passes (existing + new tests).
- Mock upstream test: pool with 2 accounts; session A binds to account 1; mock returns 429 for
  account 1 → same request succeeds on account 2; at mocked reset time account 1 is selected again
  for a new session.
- Pool off: request headers and URL to the mock upstream are byte-identical to the current
  `custom_passthrough` / `official` behavior.

## Risk / rollback
- Turning the pool off returns the agent to the old path immediately (≤ 30 s cache).
- Streaming: a retry after the first byte is impossible; the code must decide before streaming.

## Input from Core (added 2026-10-19)

- Treat a quota window whose `resets_at <= now` as reset, not as its stored `used_pct`. After a
  failed usage check Core releases an account by time and can leave stale 100 % windows from a
  429 in `usage_json` until the next good reading.
- After a 401, call `refresh` with `held_expires_at` = the `token_expires_at` of the token used, so
  concurrent 401s cause one provider refresh. `502 token_refresh_failed` means: move the session to
  another account.
- Core supports only `codex` accounts (decision 33).

## Scope after decision 33 (Codex only) — added 2026-10-19

- Only Codex pool groups exist (Core rejects `claude`). Do not build Claude account injection,
  Claude OAuth headers or the Anthropic retry change for pool accounts. The `x-tdai-user-key`
  auth precedence change (decision 1c) applies to every client and stays in scope.
- Codex pool forwarding: `POST https://chatgpt.com/backend-api/codex/responses` with
  `authorization: Bearer <access_token>` and `chatgpt-account-id: <provider_account_id>`. Client
  headers pass through unchanged (no persona rewrite). The ChatGPT backend needs `store: false`:
  set it when the body does not already have it; change nothing else in the body.
- Codex session id: header `session-id`, then `session_id`, then body
  `client_metadata.session_id`; no session id → the user key.
- Report windows to Core with the usage API names so Core can merge them: `primary_window`
  (headers `x-codex-primary-used-percent`, `x-codex-primary-reset-at` epoch s) and
  `secondary_window` (headers `x-codex-secondary-primary-used-percent`,
  `x-codex-secondary-primary-reset-at`), `model_scope: null`, `source: "header"`. A 429 body
  `{"error":{"type":"usage_limit_reached","resets_at":<epoch s>}}` gives `retry_after`.
- Own-login fallback for Codex: the client sends its own ChatGPT `authorization` and
  `chatgpt-account-id` plus `x-tdai-user-key` (Codex `requires_openai_auth = true` with
  `http_headers`). Fallback step 4 forwards those two headers unchanged to the ChatGPT backend.
- ClickHouse `subscription_account_id`: add it only if the proxy owns the table DDL; otherwise
  record the gap.

## Results (2026-10-19)

Implementer report: `plans/reports/fullstack-developer-261019-1456-proxy-pool-selection.md`.
Review: `plans/reports/code-reviewer-261019-1607-proxy-pool.md`.

- `MemoryProxy` Vitest: 12 files, 114 tests pass (the package had no tests before). `tsc`: only
  the baseline `@context-proxy/cost-guard` error.
- End to end with real Core and a mock ChatGPT backend: see
  [reports/verification-261019-subscription-pool.md](./reports/verification-261019-subscription-pool.md).
- Changed after the implementer's report:
  - A bound session keeps its account until a window reaches 100 % or the account is exhausted;
    the threshold gates new sessions only (decisions 2 and 3a).
  - Core unreachable with no earlier account list → `503`, `x-tdai-pool-status: unavailable`.
  - `direct.ts` takes the user key from `x-tdai-user-key` too.
- Fixed from the review:
  - An empty or blank `x-tdai-user-key` let the proxy user key go to chatgpt.com as a "client
    login". Blank counts as absent in auth and pool; the fallback also refuses a bearer equal to
    the user key.
  - A configured main model (`TDAI_PROXY_MAIN_MODEL_FILE`) rewrote the model of pool requests; the
    client's model is now kept (decision 11).
  - A failed report was marked as sent; it is now sent again at the next interval (not after a
    4xx).
  - Pool requests drop the TokenHub key / user key from the headers before any hook sees them.
- Left as they are (low, documented in the review): session count reads all bindings of the
  instance on each new binding; round-robin cursor is not atomic; a refreshed token with a null
  expiry is used only after the 30-second cache; legacy `/proxy/<sid>` path skips the alias for pool
  agents; utility pool requests do not record `subscription_account_id`;
  `x-parent-conversation-id` is the first session id source (subagents share the parent's account).
- Pool traffic skips the proxy TPM/QPM limits, like a custom upstream (decision 34).
- A cold Proxy start while Core is down resolves the agent to the default (TokenHub) group for one
  cache period; documented in INSTALL as existing behavior of all custom groups.
