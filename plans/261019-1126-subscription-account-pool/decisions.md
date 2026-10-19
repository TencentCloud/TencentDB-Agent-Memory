# Subscription account pool — confirmed decisions

Status: brainstorm in progress (requirements clarification). Date: 2026-10-19.

## Problem
The team has several Claude (Pro/Max) and ChatGPT/Codex subscription accounts. Each account reaches
its quota fast. Users log out and log in to another account by hand, and often do not know which
account still has quota.

## Confirmed decisions (user answers, verbatim choice in brackets)

| # | Topic | Decision |
|---|---|---|
| 1 | Where switching happens | MemoryProxy switches accounts server-side [A]. The feature is optional; the old system stays the default. |
| 1b | Optional mode | New upstream group mode `subscription_pool`, next to `official`, `custom_unified`, `custom_passthrough`. Groups not in this mode behave as today. |
| 1c | No pool / client OAuth | If no pool applies, the system works as before and forwards the client's own OAuth. The proxy user key moves to header `x-tdai-user-key`; if that header is absent, `Authorization` is still the user key (old behavior). |
| 2 | Rotation granularity | Sticky per session [B]: a new session gets the next account (round-robin); a session changes account only when its account reaches quota. |
| 3 | Quota detection | [B + C]: read rate-limit headers on every response, treat 429 as a safety net, and run a usage-check job. |
| 3a | Threshold | Stop new session assignment at 95% usage; configurable in Panel. |
| 3b | Usage-check job | Run at the reset time of an exhausted account, and every 30 minutes for every account (users also log in directly, outside the proxy). |
| 3c | Usage endpoints (undocumented) | Claude: `GET https://api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20` (`five_hour`, `seven_day` → `utilization`, `resets_at`). Codex: `GET https://chatgpt.com/backend-api/wham/usage` (`rate_limit.primary_window` / `secondary_window` → `used_percent`, `reset_at`, `reset_after_seconds`). Must degrade to headers + 429 when they fail. |
| 4 | Account onboarding | OAuth login inside Panel [A]. Login in a new tab, paste code / redirect URL back into Panel. Each Panel login is an independent token family, so direct logins on user machines are not logged out. Known risk: uses public Claude Code / Codex OAuth client IDs (ToS grey area, may break). |
| 5 | Token storage | Plaintext, same as `meta_instance_upstream_config.api_key` [A]. Tokens are never returned by public APIs and never logged. |
| 6 | Pool scope | One pool per instance, System Admin only [A]; accounts attach to an upstream group (`group_id`) in mode `subscription_pool` [A]. |
| 7 | All accounts exhausted | [A + D]: when every account is past 95%, keep using the account with the lowest usage; when every account returns 429, forward the client's own OAuth if present; else return 429 with the earliest reset time and `retry-after`. No pay-per-token fallback. |
| 10 | Session Binding storage | [A]: ProxyStorage (sqlite in the default deploy); binding and round-robin cursor survive a proxy restart; v1 supports one proxy replica only (documented). Default deploy has no Redis (`deploy/global-images/start-proxy.sh:148-149`). |
| 11 | Model gate and alias for pool requests | [A]: treat the pool like a `custom` upstream — skip the pricing-table model gate and alias rewrite (`MemoryProxy/src/pipeline/stages/model-gate.ts:42-60`); forward the client's model name unchanged. |
| 12 | Internal API exposure of tokens | [C, accepted risk]: no change in this feature. Verified facts: Layer-1 Bearer gate is off by default (`deploy/global-images/.env.example:123`), port 8420 is published on all host interfaces (`start-memory-core.sh:247`), internal routes return secrets in plaintext; with the pool they will return subscription access and refresh tokens. User chose to focus on the feature; deployment must keep port 8420 on a trusted network. Documented in INSTALL (phase 6). |
| 13 | Vocabulary | [ok]: Subscription Account, Subscription Pool, Member, Client Type, Session Binding, Quota Window — see `CONTEXT.md` at the repo root. |
| 14 | Model-specific limits | [b]: store every quota window the provider returns (including per-model windows such as Opus weekly); selection checks the shared windows and the window of the requested model; Panel shows extra model windows when present. |
| 15 | Assignment for new sessions | KISS: all pool accounts are Max 20x, so plain round-robin stays as in decision 2; no weighting. |
| 16 | Session Binding lifetime | Binding expires after 2 days without requests. |
| 17 | Who used which account | [b]: add `subscription_account_id` to the existing proxy usage record (ClickHouse row); no new UI; recorded only when ClickHouse is configured. |
| 18 | Per-Member limits | None (out of scope). Existing proxy TPM/QPM limits stay. |
| 19 | Duplicate account / re-login | [a]: identify a Subscription Account by its provider account id; adding the same account again replaces the tokens of the existing row and keeps its name and state. |
| 20 | Fork strategy | [a]: feature lives in the fork only; new code in separate `subscription-pool/` modules, small hooks in core files to keep upstream merges easy. The sqlite restart-drop fix goes upstream as a separate PR. |
| 21 | Admin alerts | [a]: Panel only (status and warnings on the Subscription Pool page). |
| 22 | Token refresh timing | [a]: refresh when the access token has < 10 min left, and at once on a proxy 401; idle accounts are refreshed too so the refresh token stays alive. |
| 23 | Token refresh failure | Transient (network, 5xx): retry after 1, 5, 15 min; account keeps serving while the old access token is valid, then stops getting new sessions. Permanent (`invalid_grant`, revoked): status `auth_error` (Re-login needed) at once. |
| 24 | Refresh crash window | [a]: write the new token pair to the DB in the same step, before anything else; if a crash still loses it, the account goes to Re-login needed. |
| 25 | Scheduling mechanism | In-memory timers in Memory Core (no Redis, no periodic DB scan). On every Core start or restart, Core refreshes usage of every Subscription Account from the provider usage API, including reset times, and arms the timers from that fresh data (reset-time checks, proactive token refresh). Supersedes an earlier choice of Redis key-expiry events; Redis is not added to the deploy, and decision 10 (Session Binding in ProxyStorage) stays. |
| 26 | Startup usage refresh failure | [a]: if the usage API fails for an account at Core start, arm its timers from the DB snapshot (last usage, `exhausted_until`) and retry the usage call after 1, 5, 15 min; startup calls run one account at a time, about 1 s apart; the proxy keeps serving from the old data meanwhile. |
| 27 | Conflicting quota signals | Per Quota Window the newest observation wins; a 429 always wins (window = 100 % until its reset). |
| 28 | 429 without reset time | Mark Exhausted for 15 min, then check with the usage API; set the next check from the returned reset time, or another 15 min if none. |
| 29 | Usage API keeps failing | After 3 consecutive failures Panel shows "Usage check failing" for the account; the pool keeps working on headers and 429. |
| 30 | Release at reset time | At the reset time call the usage API; release when usage is below the Threshold; if not yet reset, check again after 15 min; if the usage API fails, release by time. |
| 31 | Proxy-side release | The proxy treats an account as usable again once `exhausted_until` has passed, even if a Core timer was missed; a new 429 goes through the normal 429 path. |
| 32 | Near-limit accounts | Core also arms a usage check at each window's reset time for accounts at or above the Threshold, so they return to service as soon as usage drops. |
| 33 | Providers after the spike (2026-10-19) | [A]: Codex only. The spike found Anthropic's published policy forbids storing or intermediating Claude.ai subscription tokens, and Claude pooling needs a client impersonation layer, which will not be built. The `claude` value stays in the schema but has no adapter; `enable`, `oauth-start` and `oauth-complete` reject it with `PROVIDER_NOT_SUPPORTED`. Claude may return later only as per-user forwarding with unmodified Claude Code. |
| 34 | Proxy TPM/QPM limits and pool traffic (2026-10-19, confirmed again after a design review) | [A]: pool requests skip the proxy TPM/QPM limits and credit reports, like custom upstreams. Verified by `MemoryProxy/src/pipeline/runners/anthropic.ts:1229-1233` (the TPM/QPM buckets are the operator's budget for its own upstream, TokenHub = `config.upstream.url`; custom upstreams are skipped) and `instance-upstream-override.ts:7` (custom = user-paid, not platform billing). Pool conversation requests go only to the pool host (chatgpt.com), proven by the end-to-end run. Decision 18 means no new per-member limits. Not changed: memory extraction for pool conversations still calls TokenHub through the system-user path (`systemUserPassthrough.ts:490-507`) unless an extraction group is set. |
| 8 | Panel UI scope | [A]: one new "Subscription Pool" page with Claude / Codex tabs. Per tab: pool on/off switch (creates the `subscription_pool` group and moves the agent; off moves it back to `default`), account list with 5h / 7d usage and reset time, active session count, add account (OAuth), enable / disable / delete account, threshold setting. No general upstream-group UI. |

## UI mockup (approved by user on 2026-10-19)
- `mockup/subscription-pool-mockup.html` — part 1 rebuilds every existing Panel screen from code (labels from `MemoryPanel/web/src/i18n/en-US.ts`); part 2 shows NEW and CHANGED screens. Deep link: `#/<page>` or `#/<page>/<modalId>`.
- Proposed (not yet confirmed): client connection guidance goes into the existing Guide page ("Connect your IDE" → manual config) instead of a new tab; the API Key page gets one hint line.

## Verified reuse points (GitNexus + source)
- `resolveForAgent` — `MemoryProxy/src/instance-upstream-cache.ts:201`; impact LOW (3 direct callers: `stageInstanceUpstreamEarly`, `stageInstanceUpstreamResponses`, `runUtilityPipeline`).
- Claude Code header hook: `target.authHeaders` overrides auth; empty `effectiveApiKey` passes client headers through — `MemoryProxy/src/pipeline/runners/anthropic.ts:372-410`.
- Codex has no `target.authHeaders` support — `MemoryProxy/src/pipeline/runners/codex.ts:268-284`; override goes through `headerUpdates` / `overrideUrl` in `stageInstanceUpstreamResponses` (`instance-upstream-responses.ts:113-125`).
- Group storage: `meta_instance_upstream_config` (`MemoryCore/src/metadata/store/sqlite-adapter.ts:347`); Mongo twin `mongodb-adapter.ts:1673`. One agent per group (`assertAgentsNotOverlap`).
- Group API: `/v3/meta/instance-upstream/groups/*`, System Admin only (`v3-meta-router.ts:390-406`, `assertCanManageUsers`); masking via `toPublicGroup` (`metadata-service.ts:2621`).
- Panel has no UI for upstream groups today (no page in `MemoryPanel/web/src/pages` calls `groups/*`).

## Design risks checked by code reading (spike must confirm with real traffic)
- Claude OAuth gating vs memory injection: injectors append to the system message or the user message; no injector uses `system.prefix` (only `MemoryProxy/src/injection/pipeline.ts` and `types.ts` reference it). Claude Code's own first system block stays first. Request headers such as `anthropic-beta` and `user-agent` pass through; only hop-by-hop headers and `x-tdai-user-key` are stripped (`MemoryProxy/src/common/constants.ts:34-46`). Spike: send a real OAuth token through the proxy with injection on.
- Session key per agent already exists: Claude Code sends `x-claude-code-session-id` (`MemoryProxy/src/identity.ts:436`); Codex sends `session-id` header with fallback `body.client_metadata.session_id` (`MemoryProxy/src/pipeline/runners/codex.ts:188-205`). Reuse these for the account binding.
- Codex client OAuth forwarding is unverified: Codex has `chatgpt_base_url` (default `https://chatgpt.com/backend-api/`), but it is not yet known whether model requests follow it, which path they hit, and which headers they send (`chatgpt-account-id`, `originator`, `session_id`). If Codex cannot send its ChatGPT OAuth to the proxy, decisions 1c and 7 ("forward client OAuth") do not apply to Codex. When the proxy swaps a Codex account it must swap `chatgpt-account-id` together with `authorization`.

## Technical decisions
- Confirmed by user (question 9, choice A): Core is the single owner of tokens: it stores accounts, exchanges OAuth codes, refreshes tokens, and runs the usage-check job. One owner prevents refresh-token rotation races between proxy nodes.
- Proxy owns account selection: session-to-account binding in Redis / ProxyStorage, round-robin cursor, immediate cooldown on 429, one transparent retry with another account before the stream starts, one refresh-and-retry on 401.
- Proxy reports observed quota (headers, 429) to Core through a new internal endpoint, throttled to changes; Core keeps the snapshot that Panel shows.
- Account list reaches Proxy through the existing internal instance-upstream fetch and its 30 s cache.
- A spike phase verifies, before build: Codex ChatGPT backend URL and required headers, Claude OAuth request headers, usage endpoint shapes, rate-limit header names.

## Open questions
- None. Design tree closed on 2026-10-19 after the grilling session (decisions 10–32).
