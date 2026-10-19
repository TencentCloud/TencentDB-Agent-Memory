# Proxy pool selection and forwarding (Codex only)

Status: DONE_WITH_CONCERNS. Date 2026-10-19 (Asia/Saigon). Nothing committed.

## Result
- `cd MemoryProxy && npx vitest run`: 12 files, 102 tests, all pass. MemoryProxy had no test files before, so the baseline was "No test files found"; "all pass" means the new suites.
- `npx tsc --noEmit`: exactly 1 error, the pre-existing `src/storage/factory.ts(102,32)` cannot find `@context-proxy/cost-guard`. No new errors.

## GitNexus impact (upstream)
All LOW unless noted: resolveForAgent (3 direct callers), shouldOverride, stageInstanceUpstreamEarly, stageInstanceUpstreamResponses, runUtilityPipeline, extractApiKeyFromContext, stageModelGate, runCodexPipeline, codex forwardToUpstream, consumeCodexStream, stageWriteUsageLog, buildClickHouseRow, ensureClickHouse, migrateSchema, initClickHouse. MEDIUM: stageAuth (5 direct callers; behavior without the new header unchanged), logger.writeLog (26 impacted; additive optional field). HIGH: `writeClickHouse` (20 impacted). It was NOT edited: the new column flows through `buildClickHouseRow` and `writeLog`, and `writeClickHouse` passes the entry object through.
`detect-changes --scope all` reports critical for the whole tree because earlier-phase Core work is uncommitted there; the MemoryProxy part is the file list below.

## Files
Modified: src/pipeline/runners/anthropic.ts (user key vs client credential), src/pipeline/stages/auth.ts, src/instance-upstream-cache.ts, src/pipeline/stages/instance-upstream-responses.ts, src/pipeline/runners/codex.ts, src/pipeline/runners/utility.ts, src/pipeline/runners/openai-chat.ts, src/systemUserPassthrough.ts, src/clickhouse.ts, src/logger.ts, src/types.ts, scripts/qa/mock-core.mjs, README.md, README_CN.md, v3-api-memoryproxy-doc.md.
Created: src/subscription-pool/{types,selector,binding-store,account-cache,core-client,quota-signals,reporter,exhausted-response,pool-request}.ts and tests under src/subscription-pool/__tests__/ and src/pipeline/stages/__tests__/.

## Deviations and decisions
1. Account eligibility: status `active`, or `exhausted` with `exhausted_until` already passed (proxy-side release by time). The phase text says "status=active" only; the release rule follows the same section.
2. DECISION NEEDED (possible reversal of decisions 2 and 3a). Decision 2: "a session changes account only when its account reaches quota". Decision 3a: "Stop new session assignment at 95% usage". The phase text says the selector keeps the bound account "while eligible" (eligible includes below threshold), so as built a bound session at 96% but not exhausted is rebound. Trade-off: rebinding at the threshold spreads load and avoids hitting the 429 mid-turn, but it breaks prompt-cache continuity and moves sessions before they must. Options: A) rebind at the threshold (as built); B) a bound session stays until it is exhausted, the threshold gates only new bindings (one-line change in `selectAccount`: treat the bound account as eligible when servable). Recommendation: B, which matches the confirmed decisions word for word. Keep / change?
3. Session id order: `x-parent-conversation-id` first (subagents share the parent's account, same as existing session identity), then `session-id`, `session_id`, body `client_metadata.session_id`, then the user key.
4. Bindings use the `nottl/` bucket with an explicit 2-day expiry check on read; expired bindings are pruned when sessions are counted. Reason: the sqlite sweeper TTL (`storage.ttlDays`) is unrelated to 2 days.
5. Selection runs inside codex `forwardToUpstream`, not in the stage. `stageInstanceUpstreamResponses` returns `pool: {row}` (only when `poolSupported: true`; workbuddy leaves it off and keeps the official path).
6. codex `buildUpstreamHeaders` is NOT changed. The pool credentials are applied after it per attempt (`applyPoolAuth`), and the client's own `authorization` / `chatgpt-account-id` are restored from the original request for the own-login fallback.
7. Pool URL: `base_url` of the pool group if set (tests and mock-core), else `https://chatgpt.com/backend-api/codex`, joined with `joinUrl` so `/responses/compact` etc. resolve.
8. Retry budget: at most 3 upstream calls (initial, one account switch after a 429 or failed refresh, one refresh retry). A 429 on the retry falls to the own login or the exhausted 429. A failed refresh holds the account for 60 s locally.
9. 429 or any report is subject to the 5 s per-account throttle (first report immediate, later ones merged). The local overlay in the account cache makes the exhaustion effective at once.
10. Security fix beyond the file list: `openai-chat.ts` used the hop-by-hop header set that did not strip `x-tdai-user-key`, and `systemUserPassthrough.ts` had its own list without it. Once the header is a user credential for every client, that would leak it upstream. Both now strip it. Behavior without the header is unchanged.
11. The exhausted response uses epoch seconds for `x-tdai-pool-earliest-reset` and the body `resets_at`; `retry-after` is 900 when no reset time is known.
12. Model gate: pool treated as custom inside the codex runner (no pricing gate, no alias rewrite, also for auxiliary requests). `shouldOverride` and `stageInstanceUpstreamEarly` are unchanged because Claude/OpenAI runners do not support pools.
13. Utility routes use the pool only for protocol `openai` entries; a pool group on an Anthropic route stays on the official path.
14. ClickHouse: the proxy owns the DDL, so `subscription_account_id` was added to the CREATE TABLE and `migrateSchema`. Filled for both stream and non-stream codex paths.
15. Pool OFF identity: `pool-off-identical.test.ts`. Six cases were written and passing on the unmodified tree before any code change (official, zero rows, custom_unified, custom_passthrough, utility official, no pool call to Core). Two cases were added later (user key header stripped and client authorization forwarded; pool group on an unsupported agent stays official). `auth-user-key-header.test.ts` covers the old header layouts in all three extraction modes.
16. `src/auth.ts` is not modified: `verifyUserKey` takes the key as a parameter, extraction lives in the stage.
17. User key in anthropic and openai-chat runners: these runners had their own key extraction, which ignored `x-tdai-user-key`, so with the header the client's Claude/OpenAI credential would have been treated as the user key (wecom identity, TDAI ACL, key id). They now use the header as the user key and keep the client credential for `stageInstanceUpstreamOverride`, so a `custom_passthrough` group still receives the client's own key and never the user key (guard tests in `user-key-header-upstream.test.ts`). Without the header the code path is the same as before.
18. Reporter: a 429 in a batch is sticky; a later 401 in the same 5 s interval does not replace it (Core acts only on 429).

## Not done / not verifiable here
- No live ChatGPT backend run; only mock upstream and mock Core.
- `scripts/qa/mock-core.mjs` has a `pool` mode (smoke by hand: MOCK_MODE=pool; MOCK_POOL_BASE_URL points the group at a mock upstream). No shell smoke script was added.
- Codex `http_headers` client snippet in the docs comes from the spike (Codex config reference), not from a live Codex run.

## Known behavior and gaps
- Core unreachable on the first call, no stale snapshot and no client login: the pool is empty and the client gets the "exhausted" 429 with retry-after 900. Misleading status for an outage.
- Session counts are reported on bind or rebind only; a binding that expires silently is not reported until the next change on that account.
- `direct.ts` (the /direct passthrough route) has its own key extraction used for the key id only and does not verify; it ignores `x-tdai-user-key`. Left as is.
- Report path: the hook suggested another directory and timestamp; I followed the orchestrator's explicit path.
- A pool group on an agent other than codex (Core does not create one) is handled as the official path by the Anthropic, OpenAI chat and workbuddy runners.
