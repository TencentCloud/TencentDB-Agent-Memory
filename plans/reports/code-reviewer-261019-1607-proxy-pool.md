# Code review: MemoryProxy Codex subscription account pool (uncommitted)

Date 2026-10-19 (Asia/Saigon). Read-only review. Branch `feat/subscription-account-pool`.

## Scope
- Files: `MemoryProxy/src/subscription-pool/*` (9 new modules, 12 test files), `pipeline/runners/{codex,utility,anthropic,openai-chat,direct}.ts`, `pipeline/stages/{auth,instance-upstream-responses}.ts`, `instance-upstream-cache.ts`, `systemUserPassthrough.ts`, `clickhouse.ts`, `logger.ts`, `types.ts`.
- LOC: about 1 050 new source lines and 1 280 test lines; 357 insertions in modified files.
- Spec: phase-04 sections "Input from Core" and "Scope after decision 33", decisions 1c, 2, 3, 3a, 7, 10, 16, 27, 31, 33.
- Checks run: `npx vitest run` gives 12 files, 106 tests, all pass. `npx tsc --noEmit` gives only the known `@context-proxy/cost-guard` error (`src/storage/factory.ts:102`). Repro tests: a scratch vitest file outside the repo that uses the project test harness (4 scenarios, all reproduced).

## Overall assessment
The core design is sound. Selection is pure, CAS binding is atomic on sqlite, the retry happens before the first byte, the overlay makes a 429 effective at once, and tokens stay out of logs. One confirmed credential leak blocks the merge (C1). Two confirmed behavior defects conflict with confirmed decisions (H1, M1). The other findings are hardening and test gaps.

---

## Confirmed findings (reproduced or traced)

### C1. CRITICAL/HIGH: an empty `x-tdai-user-key` sends the proxy user key to chatgpt.com
- `MemoryProxy/src/subscription-pool/pool-request.ts:127-128` against `MemoryProxy/src/pipeline/stages/auth.ts:64-65`.
- `clientLoginAllowed = clientHeaders.has("x-tdai-user-key") && authorization`. `has()` is true for an empty header value. `extractApiKeyFromContext` treats an empty header as absent (`if (userKeyHeader)`) and uses the bearer as the user key. So the same bearer is verified as the proxy user key and also forwarded as "the client's own login".
- Repro (scratch test): headers `x-tdai-user-key: ""`, `authorization: Bearer sk-mem-user`, every account exhausted. Result: 200, one upstream call to `https://chatgpt.com/backend-api/codex/responses` with `authorization: Bearer sk-mem-user`. Same result when Core is down (R1b), so the empty header also skips the decided 503 `unavailable` answer.
- Trigger: a client config whose `http_headers` value is empty, for example `setup-proxy.sh --codex-own-login` run with an empty `USER_KEY`, or a templating gap.
- Fix: `Boolean(input.clientHeaders.get("x-tdai-user-key")?.trim())`. Better: let the runner pass `clientLoginAllowed` as computed from the same function that resolved the user key, so the two cannot drift. Optionally also refuse the fallback when the client bearer equals `userKey`.
- Test to add: empty header + exhausted pool gives 429 and zero upstream calls. Empty header + Core down gives 503.

### H1. HIGH (conditional): `applyMainModel` rewrites the model of pool requests
- `MemoryProxy/src/pipeline/runners/codex.ts:339` runs before the pool resolution at `:399` and `:417`.
- When `TDAI_PROXY_MAIN_MODEL_FILE` holds a model, `body.model` is overwritten before the pool check. `modelId = requestedModel` then reads the rewritten value.
- Repro (R2): main-model file `{"model":"claude-opus-5"}`. The pool request reaches chatgpt.com with `model: "claude-opus-5"`, so the ChatGPT backend rejects it. This conflicts with decision 11 / phase-04 "the client's model name is forwarded unchanged".
- Exposure: the env var is not set in `deploy/` (grep). It is set by the effort page when an operator uses it, and then every pool turn fails.
- Fix: resolve the pool kind first, and skip `applyMainModel` (and keep `requestedModel` from the original body) when `_codexIsPool`. Add a test with the env var set.

### M1. MEDIUM: on a cold start with Core down, pool traffic goes to TokenHub (pay per token), not to a 503
- `MemoryProxy/src/instance-upstream-cache.ts` (zero rows on first failure gives `official`, existing design) combined with `stageInstanceUpstreamResponses`.
- Repro (R3): no cached groups and Core throws. The Codex turn goes to `http://global-upstream.test/v1/responses` with status 200. The pool code never runs, so the 503 `x-tdai-pool-status: unavailable` path is reachable only when the group list succeeds and `accounts/list` fails.
- This is not a regression and not a reversal of the 503 decision; that decision covers the account list. It is a coverage gap against decision 7 ("No pay-per-token fallback"), present for every group mode. Also, if `config.upstream.apiKey` is empty, an own-login client's ChatGPT bearer goes to TokenHub.
- Options: document it as accepted, or persist the last group list (ProxyStorage) so a restart during a Core outage keeps the pool resolution. Lead/user decision.

### M2. MEDIUM: the reporter marks readings as sent before Core accepts them
- `MemoryProxy/src/subscription-pool/reporter.ts:90-96`.
- `lastSentAt` and `lastWindows` are updated before `callPoolCore` resolves. If the report fails (Core restarting), the next identical reading is dropped by `changedWindows` (< 1 % change). Core and Panel keep the old usage until usage moves 1 % or the reset time changes. A failed `active_sessions` report is lost until the next bind.
- Fix: commit `lastWindows` in `.then`. On `.catch`, merge the body back into `pending` and arm the timer again (bounded).
- Test gap: no test proves that a failed report is retried.

### M3. MEDIUM: `active_sessions` reporting is O(n) storage reads per new binding
- `MemoryProxy/src/subscription-pool/binding-store.ts:90-108`, called from `pool-request.ts:262` on every bind or rebind.
- `listNames` + `getJSON` for each binding in the instance. Bindings live 2 days, and every Codex launch (or user-key fallback) adds one. This runs in the background, so it does not block the response, but it is an N+1 scan on sqlite for each new session. Expired bindings are also never reported as a decrement until the next bind on that account (known gap, implementer report).
- Fix: keep in-memory per-account counters (one replica is decided), or count with one `SELECT ... LIKE prefix` query; report periodically.

### L1. LOW: round-robin cursor is read-then-write, not atomic
- `pool-request.ts:217` (`getCursor`) and `:246` (`setCursor`); `binding-store.ts:110-117`.
- Two concurrent new sessions read cursor N, both pick account N, and both write N+1. Under a burst, round-robin skews. In the lost-CAS path (`pool-request.ts:255-259`), the cursor still advances past an account the session did not get. `putJSONIfAbsent` protects only the binding (verified atomic on sqlite: `sqlite-storage.ts:86`, `changes === 1`).
- Fix: an in-process counter (one replica), or a CAS loop on the cursor key.

### L2. LOW: the refreshed token is not used when Core returns `token_expires_at: null`
- `MemoryProxy/src/subscription-pool/account-cache.ts:98`. The overlay applies only when `expiresAt > account.token_expires_at`; `null > null` (as 0 > 0) is false.
- Effect: until the next 30 s snapshot, every request first gets a 401 with the old token, then a refresh call to Core (Core answers from storage), then a retry. Fix: apply the overlay token when it differs from the snapshot token and the snapshot is not newer.

### L3. LOW: the legacy `/proxy/<sid>` path skips the model gate and alias for a pool agent
- `codex.ts:394-417` resolves `codex` without `forceOfficial`. `forwardToUpstream` then forces official for the legacy path. The result is a TokenHub call with the display name not resolved. This is the same latent pattern that already exists for `custom` override groups. Fix: compute `_codexIsPool` with the same `forceOfficial` rule.

### L4. LOW: utility (aux) pool requests do not record `subscription_account_id`
- `MemoryProxy/src/pipeline/runners/utility.ts:233` `writeLog` has no `subscriptionAccountId`. Spec: "filled for pool requests". Codex stream and non-stream paths are correct (stream through `logMeta` spread at `stream-finalize.ts:69`, verified).

### L5. LOW: session id order deviates from the spec
- `pool-request.ts:79-86` puts `x-parent-conversation-id` before `session-id`. The spec says `session-id`, `session_id`, then body. The deviation is documented (implementer item 3) and matches `extractCodexSessionId`, but no user decision records it. Confirm with the user.

### L6. LOW: a 401 on the second account after a switch is not refreshed
- `pool-request.ts:169-182`. The `refreshes` budget is shared over the request: 429 on A, then 401 on B gives one refresh on B. But a 401 on A, a failed refresh, then a 401 on B returns 401 to the client without trying B's refresh. This is within the decided budget of 3 calls. Note only.

---

## Speculative (needs verification)

### S1. Preparation stage gets pool URL with non-pool credentials
- `codex.ts:1092-1095`. `prepareUpstreamRequest` receives `upstreamCall: { upstreamUrl: chatgpt.com/..., headers: upstreamHeaders }`. These headers come before `applyPoolAuth`, so `authorization` is the global TokenHub key, or the client bearer (the proxy user key when there is no `x-tdai-user-key`).
- If the private cost-guard package makes side calls with `upstreamCall`, it sends the TokenHub key or the user key to chatgpt.com. `packages/cost-guard` is not in this checkout, so this cannot be verified. Fix (cheap): for pool requests pass headers without `authorization` / `x-api-key`, or skip side calls.

### S2. Accounts are not filtered by provider or group
- `account-cache.ts:120-126` uses every account from `accounts/list`. Core returns the accounts of every enabled pool group (`metadata-service.ts:2472-2483`). Today only Codex groups can be enabled, so this is safe. If a `claude` pool group is ever enabled, its tokens could go to chatgpt.com. Defense: filter `provider === "codex" && group_id === row.group_id`.

### S3. In own-login mode, identity derives `userId` from the ChatGPT JWT
- `identity.ts:111-122` splits the bearer at the first dot, so `userId` is the JWT header segment (the same for all users) in the `[identity]` console line. It is not persisted (no consumer of `customHeaders` / `apiKeyPrefix` outside `identity.ts`). This only confuses the logs.

---

## Area checklist results
1. **Pool OFF regression**: No byte change found for official, custom_unified, custom_passthrough, utility, anthropic, or openai-chat without the header (traced and tested). Behavior changes when the header is present: openai-chat now strips `x-tdai-user-key` (`openai-chat.ts:241-242`), and `systemUserPassthrough.ts:79` does the same; both are fixes. Codex aux now calls `getInstanceUpstreamConfigs` in the gate block (cached, no visible change). `pool-off-identical.test.ts` asserts chosen headers, URL and body, not the full header map, so "byte-identical" is not fully proven.
2. **Security**: C1 confirmed. `applyPoolAuth` deletes `authorization`, `x-api-key` and `chatgpt-account-id` before it sets the account values (OK). `x-tdai-user-key` is stripped in the codex, utility, anthropic, openai-chat and systemUser paths. Tokens are not logged (`pool-request.ts` logs account_id only; `core-client.ts` errors carry path and status only). `direct.ts:58-60` now prefers the header for keyId. The implementer report says "left as is", which is stale.
3. **Retry**: Status is handled before the response is returned to the runner, so the first byte goes out only after the decision. The body is re-serialized per attempt (codex) or is an ArrayBuffer (utility), so it is safe to send again. 429 and 401 bodies are consumed with `text()`. Budget is 3 calls. `held_expires_at` = `token_expires_at` of the token used (OK). The local overlay applies at once (OK). L2 and L6 are noted.
4. **Binding store**: The CAS is atomic on sqlite. The `nottl/` bucket is never swept (`sqlite-storage.ts:126-132`), and the 2-day expiry is checked on read (OK). The cursor race is L1. The session order is L5. `active_sessions` is M3.
5. **Reporter**: Never blocks (fire-and-forget with a `setTimeout`, `unref`). The 5 s batch is per account. Window names are `primary_window` / `secondary_window`, `model_scope: null`, `source: "header"` (OK). The 429 `retry_after` comes from body `resets_at`, then `resets_in_seconds`, then the `retry-after` header (OK). M2 is noted.
6. **Model gate / credit / ClickHouse**: The pool skips the pricing gate and the alias (OK, except H1 and L3). `skipCreditReport` is true, which also skips `enforceRateLimit` (`codex.ts:1150`) and `stageRecordTokenUsage` (`:1310`, `:1653`). This matches the override semantics, but decision 18 says "existing proxy TPM/QPM limits stay". Confirm that the intent was TokenHub protection only. The ClickHouse column is in the DDL and in `migrateSchema` (OK). L4 is noted.

The implementer's "DECISION NEEDED" item 2 is already resolved in code: `selector.ts:83-88` keeps a bound account until a window reaches 100 % or the account is exhausted, as decided. Do not reopen it.

## Test gaps
- Empty `x-tdai-user-key` (C1).
- `TDAI_PROXY_MAIN_MODEL_FILE` set with a pool (H1).
- A failed report is not suppressed or is retried (M2).
- Cold start with Core down and no group cache (M1, document the expected result).
- `enforceRateLimit` is skipped for the pool (decision 18 check).
- The concurrency test for bindings runs on the `memory` backend only; there is no sqlite run.
- The pool-off test does not compare the full header map.
- Utility pool usage-log column (L4).

## Recommended actions (order)
1. Fix C1 and add its tests (blocks the merge).
2. Fix H1 (move the pool check before `applyMainModel`).
3. Fix M2 (commit after success, requeue on failure).
4. Decide M1 with the user (accept and document, or persist the group list).
5. M3 / L1: in-process counters and cursor (one replica is decided).
6. L2, L3, L4, S1 (strip auth from `upstreamCall` for pool), S2 (provider/group filter).

## Unresolved questions
- Decision 18 against `skipCreditReport` skipping TPM/QPM for pool traffic: is this intended?
- Session id order (`x-parent-conversation-id` first): does the user confirm it?
- Does cost-guard use `upstreamCall.headers` for side calls (S1)?

Status: DONE_WITH_CONCERNS
