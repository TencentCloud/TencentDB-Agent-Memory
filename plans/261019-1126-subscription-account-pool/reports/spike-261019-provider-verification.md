# Spike: Provider Verification for the Subscription Account Pool

Date: 2026-10-19 (Asia/Saigon). Scope: desk spike for Claude Pro/Max (Claude Code OAuth) and ChatGPT Plus/Pro (Codex CLI OAuth).

**Everything in this report is desk-verified, not live-tested.** No real account, token, or secret was used or written. All values come from public source code and public docs read on 2026-10-19.

## 0. Verdict (read this first)

1. **Claude: the design is prohibited by Anthropic's published policy, and is technically hostile.** The official Claude Code legal page says: "Anthropic does not permit third-party developers ... to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." MemoryCore (stores tokens) plus MemoryProxy (forwards with them) is exactly that. Anthropic "reserves the right to take measures to enforce these restrictions ... without prior notice." Confidence: high (primary source). See section 3.
2. **Claude: the technical path exists but needs a client impersonation layer** (spoofed UA, `x-app`, beta list, billing block, TLS fingerprint, tool and prompt rewriting). Every working open-source proxy does this. It breaks on Anthropic's schedule. Confidence: high.
3. **Codex: the technical path is simple and stable, and OpenAI is permissive for personal use, but pooling is a grey area.** A server can log in with the device-code flow (no localhost redirect) and call `chatgpt.com/backend-api/codex/responses` with a Bearer token plus `ChatGPT-Account-ID`. Confidence: high for mechanics, low for policy (no primary OpenAI policy text found for pooling).
4. **Recommended ranking for the pool:** (1) Codex accounts, with device-code login; (2) Claude accounts only after a legal decision from the product owner, and only in "each end user connects their own account" form; (3) do not ship Claude pooling that shares one subscription across several end users.

Status of the plan: **needs a product and legal decision before any Claude code is written** (see section 9).

## 1. Sources and credibility

| Short name | Source | Pin | Credibility |
|---|---|---|---|
| CC-bin | `@anthropic-ai/claude-code@2.1.303` native binary (darwin-arm64), embedded JS read with `strings` (build 2026-10-18, git `07df2aedd2d01d2f60907b8404acbda187b04072`) | npm tarball | Highest for Claude constants. Official client. Line numbers are not stable in a binary, so the report cites the code symbol. |
| CC-legal | https://code.claude.com/docs/en/legal-and-compliance | fetched 2026-10-19 | Highest for policy. Official. |
| CPA | https://github.com/router-for-me/CLIProxyAPI (Go, MIT, 55k stars) | `2422c6b0f5fe16495320fa29456493874c1977a0` | High. Active, measured against real Claude Code 2.1.2xx captures. |
| CCF | https://github.com/tombii/better-ccflare (TypeScript, MIT) | `b4fe14b64e38b454929fc0ad6ca74ee062cf4191` | High. TypeScript, closest to MemoryCore stack. Fork of snipeship/ccflare. |
| OCA | https://github.com/ex-machina-co/opencode-anthropic-auth (TypeScript, MIT, 558 stars) | `93cdd23b95f84a1d495744c2e6cc4058b5a86381` | High. Has mitmproxy captures and changelog of server-side breakage. |
| CODEX | https://github.com/openai/codex (Rust, Apache-2.0) | `89461ea6833832b0551ce24ee32205824d5c108d` (2026-10-19) | Highest for Codex. Official client source. |
| LB | https://github.com/Soju06/codex-lb (Python, MIT) | `72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e` | Medium-high. Third-party, but built on real traffic. |
| OAI-docs | https://learn.chatgpt.com/docs/auth (redirect target of developers.openai.com/codex/auth) | fetched 2026-10-19 | Highest for Codex policy and storage advice. |
| News | pasqualepillitteri.it, falcao.org (fetch failed, HTTP 530), search snippets | 2026-10-19 | Low-medium. Secondary. Used only for the enforcement timeline. |

Not found: a primary OpenAI policy page that forbids or allows pooled ChatGPT subscription tokens in third-party servers. Not covered: `ccusage` and `claude-code-router` source (the questions are answered by primary sources above; both read the same files and endpoints).

## 2. Corrections to names assumed in the task

| Assumed | Actual (verified) |
|---|---|
| Claude manual redirect `console.anthropic.com/oauth/code/callback` | `https://platform.claude.com/oauth/code/callback` (CC-bin `MANUAL_REDIRECT_URL`; CCF `oauth.ts:45`; OCA `constants.ts`). |
| Claude token URL `console.anthropic.com/v1/oauth/token` | `https://platform.claude.com/v1/oauth/token` (CC-bin `TOKEN_URL`; CPA `anthropic_auth.go:27`). |
| Codex header `x-codex-primary-reset-after-seconds` | `x-codex-primary-reset-at` (epoch seconds), CODEX `codex-api/src/rate_limits.rs:292`. |
| Codex secondary header `x-codex-secondary-*` | `x-codex-secondary-primary-used-percent` etc. (odd name), `rate_limits.rs:309-317`. |
| Codex 429 body `resets_in_seconds` | codex-rs reads `error.resets_at` and `error.limit_window_minutes` (`api_bridge.rs:353-354`). `resets_in_seconds` appears only in LB (`proxy.py:2000`). |
| Codex redirect `http://localhost:1455/auth/callback` | Source builds `http://127.0.0.1:{port}/auth/callback`, default port 1455, fallback 1457 (`login/src/server.rs:78-80,194`). CPA and CCF still send `localhost`. Both work in practice, not verified here. |
| Codex session header `session_id` | Current source sends `session-id` and `thread-id` (`codex-api/src/requests/headers.rs:8-11`). Older versions used `session_id`. |

## 3. Policy and design-invalidation risks

| # | Risk | Evidence | Confidence |
|---|---|---|---|
| R1 | **Anthropic policy forbids routing, collecting, storing or intermediating subscription credentials.** | CC-legal, section "Authentication and credential use". Also: "OAuth authentication is intended exclusively for purchasers of Claude ... plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Only exception: a platform may host the **unmodified** Claude Code binary where each end user signs in with their own plan. | High |
| R2 | Anthropic can and does enforce. Reported timeline: bans from Jan 2026, technical OAuth blocks 2026-01-09, ToS update Feb 2026, wide enforcement from 2026-04-04. | News (secondary). Consistent with R1 and with the evasion code in R3 to R6. | Low-medium |
| R3 | Server-side client detection. Native detection needs four signals together: `x-app: cli`, a `claude-cli/<ver> (external, <entrypoint>)` user agent, `claude-code-20250219` in `anthropic-beta`, and a valid `metadata.user_id`. | CPA `internal/runtime/executor/helps/claude_client_detection.go` (`DetectClaudeCodeRequest`, `claudeCodeNativeUserAgentPattern`). | High |
| R4 | A signed billing block must lead `system[0]`: `x-anthropic-billing-header: cc_version=<ver>.<3-hex>; cc_entrypoint=<entry>; cch=<5-hex>;`. `cch` is the first 5 hex of SHA-256 of the first user message text. The 3-hex suffix is a SHA-256 of a salt, 3 sampled characters, and the version. | OCA `src/cch.ts`, `src/constants.ts` (`CCH_SALT`, `CCH_POSITIONS`); CC-bin string `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...`; CPA `claude_executor_cloaking.go:150-158`. Salt copied from a decompiled binary by OCA changelog 1.5.0. | High |
| R5 | Model gating by reported client version. An old reported version gets HTTP 400 `claude_code_version_too_old`: "Claude Code 2.1.87 does not support this model; version 2.1.251 or newer is required". | OCA `CHANGELOG.md` 1.8.2, `src/constants.ts` (`CLAUDE_CODE_VERSION`); CC-bin string `claude_code_version_too_old`. MemoryProxy must track the latest `@anthropic-ai/claude-code` release. | High |
| R6 | A server-side classifier fingerprints third-party agent prompts. One measured phrase ("Here is some useful information about the environment you are running in:") caused an HTTP 400 `invalid_request_error` with the misleading text "You're out of extra usage." Found by bisection. | OCA `CHANGELOG.md` 1.7.5, `src/constants.ts` (`TEXT_REPLACEMENTS`). | High (one phrase), medium (general behaviour) |
| R7 | Cloudflare TLS fingerprinting on Anthropic domains. CPA uses a Firefox uTLS transport "to bypass Cloudflare's bot detection". A plain Node/Bun `fetch` may be blocked. | CPA `anthropic_auth.go` (`NewClaudeAuthWithProxyURL` comment), `auth/claude/utls_transport.go`. | Medium (no measurement of a plain client in this spike) |
| R8 | Org-level block. HTTP 403 `permission_error` with `details.error_code: oauth_not_allowed_for_organization` on `/api/oauth/usage`, and "Your organization has disabled Claude subscription access for Claude Code" on `/v1/messages`. `x-should-retry: false` accompanies it. Account is unusable until an admin changes a setting. | CCF `packages/providers/src/providers/anthropic/provider.ts` (`isAnthropicOrgPermissionDenied`). | High |
| R9 | Long-lived subscription token creation can be disabled by org policy: the binary prints "This step creates a long-lived Claude.ai subscription token, which this policy does not permit". | CC-bin (install-github-app flow). | Medium |
| R10 | Codex: OpenAI deprioritises foreign clients. LB rewrites non-native requests to the `codex_cli_rs` persona "priority-downgrade mitigation". | LB `app/core/clients/proxy.py:~870-910` (`_normalize_non_native_upstream_fingerprint`). | Medium |
| R11 | Codex: pooling and credential sharing have no primary-source blessing. OpenAI docs say to treat `auth.json` "like a password" and to use API keys or an access token for automation. Search results call personal use "semi-official" and pooling "a greyer area". | OAI-docs; search snippets (low). | Low |

How the proxies work around R3 to R7 (so the cost is clear): CPA and OCA copy the exact header set, UA string, beta order, billing block and signing salt from a captured real client; rewrite OpenCode-branded system text; prefix tool names with `mcp_` (OCA `TOOL_PREFIX`); and CPA adds a Firefox TLS fingerprint and Axios-style OAuth headers (`User-Agent: axios/1.15.2`). This is a continuous maintenance job, not a one-time build.

## 4. Claude (Pro/Max via Claude Code OAuth)

### 4.1 Login: authorize, exchange (questions 1 and 6)

Verdict: the manual `code=true` flow is real and unchanged in shape. Use PKCE S256, a JSON token request, and the `code#state` paste format.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Authorize URL (Pro/Max, claude.ai login) | **Unresolved split.** CC-bin 2.1.303: `https://claude.com/cai/oauth/authorize`. CPA, CCF, OCA all still use `https://claude.ai/oauth/authorize`. | CC-bin `CLAUDE_AI_AUTHORIZE_URL`; CPA `anthropic_auth.go:24`; OCA `constants.ts` `AUTHORIZE_URLS.max` | High that both exist; low that they are interchangeable |
| Authorize URL (Console, API key flow) | `https://platform.claude.com/oauth/authorize` | CC-bin `CONSOLE_AUTHORIZE_URL`; OCA | High |
| client_id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public client, no secret) | CC-bin `CLIENT_ID`; CPA `:33`; CCF `config/index.ts:1286`; OCA | High |
| Authorize query | `code=true`, `client_id`, `response_type=code`, `redirect_uri`, `scope` (space separated), `code_challenge`, `code_challenge_method=S256`, `state`. Optional: `orgUUID`, `login_hint`, `login_method`. | CC-bin function building the URL (`searchParams.append("code","true")` ...); CCF `oauth.ts:50-65` | High |
| redirect_uri, manual flow | `https://platform.claude.com/oauth/code/callback` (the page that shows the code) | CC-bin `MANUAL_REDIRECT_URL`; CCF `oauth.ts:45`; OCA `CODE_CALLBACK_URL` | High |
| redirect_uri, local flow | `http://localhost:{port}/callback` (CPA fixes port 54545) | CC-bin; CPA `:34` | High |
| Scopes, subscription login (current) | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`, plus `user:plugins` when the plugin scope is registered (it is `true` in 2.1.303). | CC-bin arrays `r`, `BSt()` | High |
| Scopes, console login | adds `org:create_api_key` (`[org:create_api_key, user:profile]` + the list above) | CC-bin `IWo()`; OCA `OAUTH_SCOPES` | High |
| Scopes, inference-only | `user:inference` only (used for `setup-token`, 1-year token, see 4.6) | CC-bin (`inferenceOnly:!0`, `expiresIn:Gne`, `Gne=31536000`) | High |
| PKCE | S256. Verifier is random, challenge is base64url(SHA-256(verifier)). `state` must be a separate random value (CCF notes: never reuse the verifier as state). | CC-bin; CCF `oauth.ts:12-23,62` | High |
| Pasted code format | `<code>#<state>`. Split on `#`. State from the paste overrides the stored state. | CCF `oauth.ts:72-75`; CPA `parseCodeAndState` `:352` and `:337-340` | High |
| Token URL | `POST https://platform.claude.com/v1/oauth/token` | CC-bin `TOKEN_URL`; CPA `:27` | High |
| Token request encoding | **JSON** (`Content-Type: application/json`), not form. | CC-bin (`At.post(TOKEN_URL, w, {headers:{"Content-Type":"application/json"}})`); CCF `oauth.ts:102-106` | High |
| Token request body | `{"grant_type":"authorization_code","code":"<code>","redirect_uri":"<same as authorize>","client_id":"9d1c...","code_verifier":"<verifier>","state":"<state>"}`. Optional `expires_in` (seconds). Key order mirrors native traffic in CPA. | CC-bin `F0o`; CPA `anthropic_auth.go:150-157` | High |
| Token response fields | `access_token`, `refresh_token`, `token_type`, `expires_in` (seconds; test fixtures use 28800 and 3600), `scope`, `organization{uuid,name}`, `account{uuid,email_address}`. | CPA `tokenResponse` `:104-117` and `anthropic_auth_test.go:151,237`; CC-bin reads `B.scope`, `refresh_token_expires_in` | High for the names; medium for the 8 h lifetime (test fixture only) |
| 401 on exchange | Binary treats HTTP 401 as "invalid authorization code". | CC-bin `F0o` | High |

Identity (question 6):

| Item | Value | Source | Conf. |
|---|---|---|---|
| Stable id | `account.uuid` (token response) and `organization.uuid`. Key the pool on `account.uuid`. | CPA `tokenResponse`, `ClaudeTokenData` | High |
| Profile endpoint | `GET https://api.anthropic.com/api/oauth/profile` with `Authorization: Bearer <access>`. Response: `account{uuid,email,display_name,full_name}`, `organization{uuid,name,organization_type,rate_limit_tier,seat_tier,has_extra_usage_enabled,billing_type,plan_display_name,cc_onboarding_flags,...}`. | CC-bin `RP()`/`DHr()`; CPA `OAuthProfile` `:119-127` | High |
| Plan detection | `organization.organization_type`: `claude_max` -> max, `claude_pro` -> pro, `claude_team`, `claude_enterprise`. `rate_limit_tier` gives the tier (for example a `default_claude_max_20x` string exists in the binary). | CC-bin map `IP=new Map([["claude_max","max"],...])` | High |
| Companion call | After login the client also calls `GET /api/oauth/claude_cli/roles` within about 500 ms. Advisory only. | CPA `inspectOAuthAccount` | Medium |
| Profile call headers | `User-Agent`, `Authorization: Bearer`, `Content-Type: application/json`, `Cache-Control: no-cache`. No `anthropic-beta` needed on the OAuth profile call in the native client. | CC-bin `RP()` | High |

### 4.2 Refresh (question 2)

Verdict: JSON POST, refresh token **rotates and is single-use**. MemoryCore must persist the new refresh token before using the new access token, and must never retry a refresh after an ambiguous transport error.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Request | `POST https://platform.claude.com/v1/oauth/token`, JSON: `{"grant_type":"refresh_token","refresh_token":"<rt>","client_id":"9d1c...","scope":"<space separated scopes>"}`. Optional `expires_in`. | CC-bin `Ete()`; CPA `:530-537` | High |
| CCF variant | Same body without `scope`. Works in CCF production use. | CCF `providers/anthropic/provider.ts` (`refreshToken`) | Medium |
| Response | `access_token`, `expires_in`, `refresh_token` (optional), `scope`, `refresh_token_expires_in` (optional). | CC-bin; CCF | High |
| Rotation | The client does `refresh_token: K = e` (falls back to the old token when none is returned). CPA says the token is "single-use": a lost response "can turn a transient network fault into `invalid_grant`". OCA 1.7.4: "re-read auth before token refresh ... when token rotation occurs between requests". | CC-bin `Ete()`; CPA `isClaudeRefreshRetryable` `:118-127`; OCA `CHANGELOG.md` 1.7.4 | High |
| Failure codes | `invalid_grant` / `invalid_refresh_token` (HTTP 400 or 401) = account needs new login. HTTP 429 on refresh = back off (CPA blocks that token for `Retry-After`, 5 s to 5 min). | CCF `provider.ts`; CPA `:70-108` | High |
| Concurrency | CPA collapses concurrent refreshes with `singleflight` per refresh token. MemoryCore needs a per-account lock or DB row lock. The native client also uses a lock file: "Lock acquisition failed after N attempts: another process is refreshing". | CPA `claudeRefreshGroup`; CC-bin string | High |
| Proactive window | CC-bin treats a token as expiring when `now + 300000 ms >= expiresAt` (5 minutes). | CC-bin `KC(e,n)` | High |

### 4.3 Calling `/v1/messages` (question 3)

Verdict: `Authorization: Bearer <access>` plus the OAuth beta is the minimum for the transport. For the request to be accepted as Claude Code traffic, the full impersonation set in the table is needed. The old "system prompt must start with the Claude Code line" rule is still the base of that set but is no longer enough alone.

| Item | Value | Source | Conf. |
|---|---|---|---|
| URL | `POST https://api.anthropic.com/v1/messages?beta=true` (OCA adds `beta=true`) | OCA `transform.ts` ~`:424-460` | High |
| Auth | `Authorization: Bearer <access_token>`. Remove `x-api-key`. | OCA `setOAuthHeaders` | High |
| `anthropic-version` | `2023-06-01` | CC-bin (33 occurrences of `"anthropic-version":"2023-06-01"`); CPA `claudeAnthropicVersion` | High |
| `anthropic-beta`, minimum | `oauth-2025-04-20` (required for OAuth bearer). OCA sends `oauth-2025-04-20,interleaved-thinking-2025-05-14` plus caller betas. | OCA `REQUIRED_BETAS`; CCF `anthropic/provider.ts:400-408` (appends `oauth-2025-04-20` if absent) | High |
| `anthropic-beta`, full Claude Code set | Starts with `claude-code-20250219`, then `oauth-2025-04-20`, `interleaved-thinking-2025-05-14`, `redact-thinking-2026-02-12`, `thinking-token-count-2026-05-13`, `context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`, then model and body dependent betas, and `extended-cache-ttl-2025-04-11` for OAuth. The list changes per request and per release. | CPA `claude_executor_request.go:139-210` (verified by CPA against native 2.1.258 and 2.1.280 captures) | High (as of 2.1.280); the list will drift |
| `user-agent` | `claude-cli/<version> (external, cli)` (entrypoint may be `sdk-cli`). Current binary: 2.1.303. | CC-bin `claude-cli/${VERSION} (external, ${entrypoint})`; OCA `formatUserAgent`; CPA regex `claudeCodeNativeUserAgentPattern` | High |
| `x-app` | `cli` (or `cli-bg` for background). Native also sends `X-Claude-Code-Session-Id`. | CC-bin function `Wl()` | High |
| Other native headers | `x-stainless-*` (lang `js`, runtime `node`, retry-count `0`), `anthropic-dangerous-direct-browser-access: true`, `Accept: application/json`, `Content-Type: application/json`. | CPA `measuredClaudeCodeHelperHeadersMatch` | Medium-high |
| System prompt prefix | Three accepted identity strings exist in the binary: `You are Claude Code, Anthropic's official CLI for Claude.`, the same plus `, running within the Claude Agent SDK.`, and `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | CC-bin strings block; CPA `claudeCodeCLIIdentity`; OCA `CLAUDE_CODE_IDENTITY` | High |
| Billing block | Required first `system` block (see R4). Layout used by OCA: `[billing block, identity, ...rest]`. | OCA `rewriteRequestBody` | High |
| `metadata.user_id` | Valid value needed for native-client detection. | CPA `DetectClaudeCodeRequest` | Medium-high |
| How other proxies treat the prefix | CPA: keeps top-level `system` in Claude Code's minimal shape and moves caller system text to mid-conversation system messages ("cloaking"); strips duplicates of the identity. OCA: prepends identity and billing block, sanitises OpenCode strings, prefixes tool names with `mcp_`. CCF: does not rewrite at all, because it forwards real Claude Code traffic. | CPA `claude_executor_cloaking.go`; OCA `transform.ts:521-604`; CCF `proxy-operations.ts` | High |
| If checks fail | Historic error: HTTP 400 "This credential is only authorized for use with Claude Code and cannot be used for other API requests" (reported in anthropics/claude-code issues #8042, #12021). Current gating errors: R5 and R6. | https://claudeissues.com/issue/8042-bug-api-400 and /12021 (mirrors of GitHub issues) | Medium |

Design consequence: if MemoryProxy forwards **real, unmodified Claude Code** traffic (the client sets all headers and system blocks) and only swaps the `Authorization` header, as CCF does, then only the bearer swap and the OAuth beta fixup are needed. If MemoryProxy serves other clients (OpenAI-format callers, other agents), the full impersonation layer in R3 to R7 is mandatory.

### 4.4 Usage endpoint (question 4)

Verdict: free (no quota cost), but rate limited itself. Poll rarely and honour `Retry-After`.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Request | `GET https://api.anthropic.com/api/oauth/usage`, headers `Authorization: Bearer <access>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<ver>` (CCF) or `claude-cli/<ver>`, `Accept: application/json`, `Content-Type: application/json`. Timeout 5 s. | CCF `usage-fetcher.ts:259-270`; CC-bin `fS` map and `qm()` | High |
| Query variants | Native client also calls `/api/oauth/usage?at_wall=1&skip_spend=1` and `?cedar_ember=1&skip_spend=1`. | CC-bin `fS` | High |
| Cost to quota | None. CCF: "free `/api/oauth/usage` polling"; plain GET that consumes no quota. | CCF `accounts.ts:4637`; `codex/usage-endpoint.ts:11` | Medium-high |
| Legacy shape | `five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_fable`: each `{utilization: number (percent), resets_at: ISO string or null}`. `extra_usage: {is_enabled, monthly_limit, used_credits, utilization}`. | CCF `usage-fetcher.ts:71-120` | High |
| New shape (2026) | `limits[]`: `{kind: "session" \| "weekly_all" \| "weekly_scoped", group, percent, severity: normal\|warning\|critical, resets_at, scope:{model:{id,display_name}, surface}, is_active}`. Per-model weekly caps exist **only** here. Also `spend{used:{amount_minor,currency,exponent}, limit, percent, severity, enabled, disabled_reason}`. Flat windows may be absent. | CCF `usage-fetcher.ts:72-106`; CC-bin parser (`kind==="weekly_scoped"`, `scope.model.display_name`) | High |
| Errors | 429 with `Retry-After` (seconds or HTTP date) or `Retry-After-Ms`; 403 `oauth_not_allowed_for_organization` (R8); 401 when token expired. | CCF `usage-fetcher.ts:276-301`; CPA `parseClaudeRetryAfter` | High |

Parse both shapes. Prefer `limits[]` when present, fall back to flat windows.

### 4.5 Rate-limit headers and the 429 (question 5)

Verdict: the `anthropic-ratelimit-unified-*` header family is authoritative. Do not enumerate names. Scan by prefix.

| Header | Meaning | Source | Conf. |
|---|---|---|---|
| `anthropic-ratelimit-unified-status` | Overall: `allowed`, `allowed_warning`, `rejected`. CCF also treats `rate_limited`, `blocked`, `queueing_hard`, `payment_required` as hard and `queueing_soft` as soft. | CC-bin; CCF `anthropic/provider.ts:10-30` | High |
| `anthropic-ratelimit-unified-reset` | Unix epoch **seconds** of the representative window reset. | CC-bin; CCF `base.ts:parseRateLimit` | High |
| `anthropic-ratelimit-unified-representative-claim` | Window that decides the result: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`. | CC-bin `updateRepresentativeClaim` | High |
| `anthropic-ratelimit-unified-fallback` | Present in the binary; meaning not read in this spike. | CC-bin strings | Low (meaning) |
| `anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization` | Fraction, not percent (0 to about 1.01). A real rejected window carried `5h-utilization: 1.01`. | CCF `retryable-429.ts` comment (measured) | Medium-high |
| `-5h-reset`, `-7d-reset`, `-5h-surpassed-threshold`, `-7d-surpassed-threshold`, `-5h-status` | Per-window data. A measured exhausted-window 429 carried **only** the per-window headers (`-5h-status: rejected`, `-5h-reset`, `-5h-utilization`) and not the aggregate ones. | CCF `retryable-429.ts` comment | Medium-high |
| `-overage-status`, `-overage-reset`, `-overage-disabled-reason`, `-overage-utilization`, `-overage-in-use`, `-overage-period`, `-overage-scope` | Extra-usage (pay as you go) state. `overage-disabled-reason: out_of_credits` is scoped to a model or beta, not the account. | CC-bin strings; CCF `isAnthropicOutOfCredits` | High |
| `-grace-5h-utilization`, `-grace-7d-utilization` | Grace zone values read by the native client. | CC-bin `Vw()` | Medium |
| `-slow-*` (status, offer, retry-after, max-wait, budget-*) | Slow-lane queueing family. | CC-bin strings | Low (not analysed) |
| `retry-after`, `x-should-retry` | Standard. `x-should-retry: true` can accompany a genuinely spent window, so it cannot decide whether to retry. | CCF `retryable-429.ts` | High |

429 body: **no captured JSON body was found in this spike.** The standard Anthropic error envelope `{"type":"error","error":{"type":"rate_limit_error","message":"..."}}` is the working assumption (medium confidence, from how CCF classifies `rate_limit_error` at `response-handler.ts:~312` and in SSE error frames). Do not match on the message text. The binary also has a typed kind `usage_limit_reached` for "refused by the account's own usage limit, a plan limit (session, weekly or per-model) or a spend cap on usage credits" with `api_error_params.rate_limit_info`. A 429 can also arrive **mid-stream** as an SSE error frame (CCF `sse-rate-limit-sniffer.ts`). Mid-stream frames carry no reset header.

### 4.6 Claude extras that matter for a pool

- **Long-lived inference token:** exchange with `scope=user:inference` and `expires_in=31536000` gives a one-year access token with no useful refresh. The binary uses this for `claude setup-token`. Trade-off: no profile or usage scopes (the usage and profile endpoints need `user:profile`), and org policy may block it (R9). Confidence: high on mechanics, medium on whether it carries a refresh token.
- **Client version drift:** keep the reported version at or above the latest npm release (R5).
- **Account health state to store:** `requires_reauth` (on `invalid_grant`), `org_permission_denied` (R8), cooldown until `anthropic-ratelimit-unified-reset`.

## 5. Codex (ChatGPT Plus/Pro via Codex CLI OAuth)

### 5.1 Login: authorize and exchange (question 7)

Verdict: use the **device-code flow** on a server. The browser flow needs a redirect to `127.0.0.1:1455` on the machine where the user's browser runs, which a server cannot receive. The manual-paste variant (user copies the failed redirect URL) also works in principle but is not in Codex source.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Issuer | `https://auth.openai.com` | CODEX `login/src/server.rs:77` | High |
| Authorize URL | `https://auth.openai.com/oauth/authorize` | CODEX `server.rs:~600` (`{issuer}/oauth/authorize`); CPA `openai_auth.go:25` | High |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` (public client, `client_auth=none`) | CODEX `login/src/auth/manager.rs:1721`; CPA `:27`; LB `settings.py:58` | High |
| Scope (current) | `openid profile email offline_access api.connectors.read api.connectors.invoke` | CODEX `server.rs:609`; CCF `codex/oauth.ts:16-23` | High |
| Scope (older, used by CPA) | `openid email profile offline_access` | CPA `openai_auth.go:80` | High (older client) |
| PKCE | S256 | CODEX `login/src/oauth/client.rs` and `pkce.rs`; error text `pkce=S256` in `oauth_session_token.rs` | High |
| redirect_uri | Source: `http://127.0.0.1:{actual_port}/auth/callback`, port 1455 then fallback 1457. CPA, CCF, LB send `http://localhost:1455/auth/callback`. | CODEX `server.rs:78-80,194`; CPA `:28`; CCF `codex/oauth.ts:15` | High (values); registered set not verified |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<value>` (default `codex_cli_rs`); optional `allowed_workspace_id=<ids>` | CODEX `server.rs:593-603`; CPA `:85-86`; CCF `codex/oauth.ts:49-51` | High |
| Token exchange | `POST https://auth.openai.com/oauth/token`, **form** (`application/x-www-form-urlencoded`): `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` | CODEX `oauth/client.rs:80-93`; `server.rs:~760` (`TokenEncoding::Form`) | High |
| Token response | `id_token` (JWT), `access_token` (JWT), `refresh_token` (all three strings) | CODEX `server.rs:~700` (`ExchangedTokens`) | High |
| `chatgpt_account_id` | Decode `id_token` payload (no signature check in Codex). Claim path: `["https://api.openai.com/auth"]["chatgpt_account_id"]`. | CODEX `login/src/token_data.rs` (`IdClaims`, `AuthClaims`); `server.rs:~830` | High |
| Other id_token claims | `email` (also `["https://api.openai.com/profile"].email`), `["https://api.openai.com/auth"].chatgpt_plan_type`, `.chatgpt_user_id`, `.user_id`, `.chatgpt_account_is_fedramp` | CODEX `token_data.rs` | High |
| Plan values | `free`, `go`, `plus`, `pro`, `prolite`, `promax`, `team`, `business`, `enterprise`, `edu` and more; the set varies by backend. | CODEX `token_data.rs` comment; `codex-backend-openapi-models/.../rate_limit_status_payload.rs` (`PlanType`) | High |
| Account identity | Use `chatgpt_account_id` plus `chatgpt_user_id`. Team workspaces share an account id across users, so the pair identifies a seat. Codex also reads `chatgpt_account_user_id` for some purposes. | CODEX `token_data.rs` (`AccountUserAuthClaims`) | Medium |

Device-code flow (headless server):

| Step | Request | Source | Conf. |
|---|---|---|---|
| 1 | `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, JSON `{"client_id":"app_EMoam..."}`. Response: `device_auth_id`, `user_code` (alias `usercode`), `interval` (a string number). HTTP 404 means the flow is disabled for that server. | CODEX `login/src/device_code_auth.rs:~60-110` | High |
| 2 | User opens `https://auth.openai.com/codex/device` and enters the code. | `device_code_auth.rs:175` | High |
| 3 | Poll `POST https://auth.openai.com/api/accounts/deviceauth/token`, JSON `{"device_auth_id","user_code"}`, until success (15 minute cap). Success returns `authorization_code`, `code_challenge`, `code_verifier` (the server owns the PKCE pair). | `device_code_auth.rs:~110-180` | High |
| 4 | Exchange at `/oauth/token` with `redirect_uri=https://auth.openai.com/deviceauth/callback` and the returned `code_verifier`. | `device_code_auth.rs:~200-215` | High |

### 5.2 Refresh (question 8)

Verdict: single-use rotating refresh token. Persist the new one immediately. The access token lives long (days), unlike Claude's 8 hours.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Request | `POST https://auth.openai.com/oauth/token`. codex-rs now sends **JSON**: `grant_type=refresh_token`, `client_id`, `refresh_token`, `refresh_reason` (`proactive_expiry`, `scheduled`, `unauthorized_recovery`, `forced`). **No `scope`.** Override env: `CODEX_REFRESH_TOKEN_URL_OVERRIDE`. | CODEX `manager.rs:1628-1651` (`TokenEncoding::Json`), `oauth/client.rs:98-112`, `manager.rs:213-215` | High |
| Older/proxy variant | Form body with `scope=openid profile email`. Still accepted. | CPA `openai_auth.go:219-226` | Medium-high |
| Response | `id_token?`, `access_token?`, `refresh_token?` (all optional). Each present field replaces the stored one. | CODEX `manager.rs:1714-1718`, `persist_tokens :1597-1625` | High |
| Rotation | Treated as rotating and single-use. Error codes: `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`. HTTP 401, or HTTP 400 `invalid_grant`, or any of these codes = permanent failure; other errors = transient. | CODEX `manager.rs:1654-1692` | High |
| Lifetime and schedule | Codex refreshes when the access token JWT `exp` is within 5 minutes (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`), or if `last_refresh` is older than 8 days (`TOKEN_REFRESH_INTERVAL = 8`). The 8-day fallback implies the access token lives longer than 8 days. | CODEX `manager.rs:204-205, 3030-3047` | High (schedule); medium (exact lifetime, read it from the JWT `exp`) |
| Storage advice | Treat `auth.json` "like a password". | OAI-docs | High |

### 5.3 Model request (question 9)

Verdict: `POST https://chatgpt.com/backend-api/codex/responses`, SSE stream, Bearer token plus `ChatGPT-Account-ID`.

| Item | Value | Source | Conf. |
|---|---|---|---|
| Base URL | `https://chatgpt.com/backend-api/codex` when auth mode is ChatGPT; `https://api.openai.com/v1` for API-key auth. | CODEX `model-provider-info/src/lib.rs:80, 427-447` | High |
| Path | `POST {base}/responses` | CODEX `codex-api/src/endpoint/responses.rs:~110` | High |
| Auth headers | `Authorization: Bearer <access_token>`; `ChatGPT-Account-ID: <chatgpt_account_id>`; `X-OpenAI-Fedramp: true` only for FedRAMP accounts. LB omits the account header when the id starts with `email_` or `local_` (synthetic ids). | CODEX `model-provider/src/bearer_auth_provider.rs:30-46`; LB `core/clients/headers.py:25` | High |
| Client headers | `originator: codex_cli_rs`; `version: <codex version>`; `User-Agent: codex_cli_rs/<ver> (<OS> <ver>; <arch>) <terminal ua>`; `session-id`, `thread-id`, `x-client-request-id` (= thread id); `x-openai-subagent` for subagents. `OpenAI-Beta: responses_websockets=2026-02-06` only on the WebSocket transport. `Accept: text/event-stream` for HTTP. | CODEX `default_client.rs:42,152-166`; `model-provider-info/src/lib.rs:~540` (`version`); `codex-api/src/requests/headers.rs:8-11`; `endpoint/responses.rs:88`; `core/src/client.rs:160,175`; LB `proxy.py:~907` | High |
| Body, fixed rules | `stream: true`; `store: false` (`core/src/client.rs:1085`); `tool_choice` string; `parallel_tool_calls`; `reasoning`; `include` list; optional `prompt_cache_key`, `service_tier`, `text`, `client_metadata`. LB forces `store=false` and `stream=true`. | CODEX `codex-api/src/common.rs:279-304`; LB `proxy.py:4875-4876` | High |
| Body, `instructions` | **Conflict.** Current codex-rs has **no** top-level `instructions` key; base instructions go in `input` as a developer message (`core/src/client.rs:996-1004`). LB says the upstream requires the `instructions` field and defaults it to `""` for the same shape (`requests.py:363-390`). | CODEX; LB | Medium |
| Differences from `api.openai.com/v1/responses` | Different host and path prefix; ChatGPT account header; `store=false` mandatory; stream mandatory; ChatGPT-only models; no `previous_response_id` with store off (history is replayed in `input`). | CODEX; LB | Medium-high |
| Persona | LB rewrites non-native callers to the `codex_cli_rs` UA, `originator`, `version`, and strips `x-stainless-*` and `x-openai-client-*`, to avoid a "priority downgrade". | LB `proxy.py:~895-912` | Medium |

### 5.4 Usage endpoint (question 10)

| Item | Value | Source | Conf. |
|---|---|---|---|
| Request | `GET https://chatgpt.com/backend-api/wham/usage`. Headers: `Authorization: Bearer <access>`, `ChatGPT-Account-Id`, `User-Agent` (Codex uses `codex-cli`), `Accept: application/json`. | CODEX `backend-client/src/client/rate_limit_resets.rs:124-129`, `client.rs:269-289`; LB `usage.py:~419` | High |
| Top level | `plan_type`, `rate_limit`, `credits`, `spend_control`, `additional_rate_limits[]`, `rate_limit_reached_type`. | CODEX `codex-backend-openapi-models/.../rate_limit_status_payload.rs` | High |
| `rate_limit` | `{allowed: bool, limit_reached: bool, primary_window, secondary_window}` (windows may be null). | `rate_limit_status_details.rs` | High |
| Window | `{used_percent: int, limit_window_seconds: int, reset_after_seconds: int, reset_at: int (epoch s)}`. Primary is the short window (about 5 h), secondary is the weekly window. | `rate_limit_window_snapshot.rs` | High |
| `credits` | `{has_credits, unlimited, balance (string), approx_local_messages[], approx_cloud_messages[]}` | `credit_status_details.rs` | High |
| `rate_limit_reached_type.type` | `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached` | `rate_limit_status_payload.rs` | High |
| Cost to quota | None found. CCF: "a plain GET that consumes no" quota; but it also notes OpenAI has no free per-request counter like Anthropic. | CCF `codex/usage-endpoint.ts:11`, `on-demand-fetch.ts:66` | Medium |
| Other helpers | `GET /wham/accounts/check`, `/wham/rate-limit-reset-credits`, `POST /wham/rate-limit-reset-credits/consume` | CODEX `backend-client/src/client.rs:403-406`, `rate_limit_resets.rs` | Medium (not needed) |

### 5.5 Rate-limit headers and usage-limit error (question 11)

| Item | Value | Source | Conf. |
|---|---|---|---|
| Primary window | `x-codex-primary-used-percent` (float), `x-codex-primary-window-minutes` (int), `x-codex-primary-reset-at` (epoch seconds). **No** `reset-after-seconds` header in current source. | CODEX `codex-api/src/rate_limits.rs:284-296` | High |
| Secondary window | `x-codex-secondary-primary-used-percent`, `x-codex-secondary-primary-window-minutes`, `x-codex-secondary-primary-reset-at` (the odd double name is real). | `rate_limits.rs:309-317` and tests | High |
| Other limit families | `x-<limit>-primary-used-percent` pattern gives extra named limits (example `x-codex-bengalfox-*`). `x-codex-active-limit` names the limit that fired. | `rate_limits.rs:336-358`; `api_bridge.rs:279` | High |
| Credits | `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-credits-balance` | `rate_limits.rs:220-222` | High |
| Other | `x-codex-promo-message`, `x-codex-rate-limit-reached-type`, `x-codex-turn-state` (continuity token, replay on follow-up turns), `x-codex-safety-buffering-enabled` | `rate_limits.rs:182-189`; `sse/responses.rs:33` | High |
| Same data inside SSE | A rate-limit event with `plan_type`, `metered_limit_name`, `primary`, `secondary`, `credits`. | `rate_limits.rs:~130-170` | Medium |
| Limit error | HTTP **429**, body `{"error":{"type":"usage_limit_reached","plan_type":"plus","resets_at":<epoch s>,"limit_window_minutes":<n>}}`. Other 429 types: `usage_not_included`, `insufficient_quota` (and codes `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`), `rate_limit_exceeded`. | CODEX `api_bridge.rs:186-235, 350-356` | High |
| `resets_in_seconds` | Not read by codex-rs. LB reads it from the same error object; treat as optional extra. | LB `proxy.py:2000-2014` | Medium |

### 5.6 Can Codex CLI send its ChatGPT token to a custom base URL? (question 12)

**Answer: yes.** A `[model_providers.<id>]` entry with `requires_openai_auth = true` and a custom `base_url` receives `Authorization: Bearer <chatgpt access token>` and `ChatGPT-Account-ID`.

Evidence chain (all CODEX `89461ea`):

1. `ModelProviderInfo.requires_openai_auth` doc: "Does this provider require an OpenAI API key or ChatGPT login token?" (`model-provider-info/src/lib.rs:~190-196`).
2. `resolve_provider_auth` (`model-provider/src/auth.rs:197-224`): returns an unauthenticated provider **only** when `!requires_openai_auth && auth.is_none()`. Otherwise it calls `auth_provider_from_auth(auth)`.
3. `auth_provider_from_auth` (`auth.rs:307-329`): for `CodexAuth::Chatgpt` returns `BearerAuthProvider{token, account_id, is_fedramp_account}`. It does not look at `base_url`.
4. `BearerAuthProvider::add_auth_headers` (`bearer_auth_provider.rs:30-46`) sets `Authorization`, `ChatGPT-Account-ID`, and `X-OpenAI-Fedramp`.
5. `to_api_provider` (`lib.rs:427-447`) uses `self.base_url` when set and only falls back to `CHATGPT_CODEX_BASE_URL` when it is unset.

Caveats: `supports_codex_backend_routes()` (`lib.rs:~620`) requires the provider **name** `OpenAI` and a `/backend-api/codex` suffix, so workspace routing and the models endpoint may not follow a custom URL (`models_endpoint.rs:~119` is also gated on API-key auth for the catalog override). Use `chatgpt_base_url` only for non-model calls (usage, plugins, remote control, `core/src/config/mod.rs:4577`); it does not redirect `/responses`. Not live-tested.

Practical use for the pool: point a stock Codex CLI at MemoryProxy with a custom provider, `requires_openai_auth = false`, and a MemoryProxy-issued key. MemoryProxy then holds the real ChatGPT token. This keeps the Codex binary unmodified and avoids sending real tokens to the client.

## 6. Comparison matrix (MemoryCore server-side)

| Dimension | Claude Pro/Max | ChatGPT via Codex |
|---|---|---|
| Server-side login | Manual paste of `code#state` (works headless) | Device code (works headless) or manual redirect paste |
| Token request encoding | JSON | Form for exchange, JSON for refresh in current codex-rs |
| Access token lifetime | about 8 h (fixture) | days (read JWT `exp`) |
| Refresh rotation | Yes, single-use | Yes, single-use |
| Identity | `account.uuid` + profile endpoint | `chatgpt_account_id` + `chatgpt_user_id` from `id_token` |
| Plan detection | `organization_type` + `rate_limit_tier` (profile) | `chatgpt_plan_type` (id_token) and `plan_type` (`wham/usage`) |
| Usage poll | `/api/oauth/usage`, free, own 429 | `/wham/usage`, free |
| Passive quota signal | `anthropic-ratelimit-unified-*` | `x-codex-*` |
| Impersonation burden | High (R3 to R7) | Low (UA, `originator`, `version`) |
| Policy status | Explicitly prohibited (R1) | Unclear (R11) |
| Breakage risk | High, ongoing | Low to medium |

## 7. Ranked recommendation

1. **Build Codex first.** Device-code login, JSON refresh with a per-account lock, `wham/usage` poll plus `x-codex-*` headers, forward to `/backend-api/codex/responses` with `codex_cli_rs` persona. Cheapest, most stable, best documented. Policy risk R11 stays; keep it to accounts whose owners consented.
2. **Claude: hold behind a decision.** If the owner decides to proceed despite R1, use the narrowest form: each end user connects their own account, and MemoryProxy forwards **unmodified Claude Code traffic** with a bearer swap (CCF model). Do not build the cloaking layer (R3 to R7) unless the decision explicitly accepts the ban risk and the maintenance cost.
3. **Reject** Claude pooling that shares one subscription across several end users, or a design that turns Claude subscription tokens into a general API for other clients. This is the case Anthropic names.

Cost and effort estimate (rough, not measured): Codex path about a few days of work; Claude path with impersonation is weeks plus permanent upkeep (the reported-version, beta list and billing salt change with every Claude Code release).

## 8. Implementation notes that follow from the evidence

- Store per account: `provider`, `account_uuid` or `chatgpt_account_id`, plan, access token, refresh token, `expires_at`, `last_refresh`, health (`ok`, `requires_reauth`, `org_blocked`, `cooldown_until`). Encrypt tokens at rest.
- Refresh: one refresh in flight per account (DB lock or advisory lock). Write the new refresh token **before** releasing the lock. Do not retry on timeout or transport error (single-use token). Refresh when less than 5 minutes remain.
- Do not poll usage on every request. Use response headers as the passive signal and poll `usage` on a slow timer, honouring `Retry-After`.
- On 429: for Claude, read `anthropic-ratelimit-unified-status`, `-reset`, `-representative-claim`; scan by prefix and never by a fixed name list. For Codex, read the `x-codex-*` headers and the `usage_limit_reached` body (`resets_at`). Handle mid-stream SSE error frames.
- Log redaction: never log `Authorization`, `refresh_token`, `code`, `code_verifier`.

## 9. Unresolved questions (need an answer before acting)

1. **Policy decision (blocking for Claude):** does the product owner accept R1? If not, drop Claude from the pool or limit it to per-user, unmodified Claude Code forwarding.
2. Claude authorize URL: `https://claude.com/cai/oauth/authorize` (binary 2.1.303) versus `https://claude.ai/oauth/authorize` (all three proxies). Needs one live check that both redirect to the same consent page and accept the same `redirect_uri`.
3. Codex `instructions` field: does `chatgpt.com/backend-api/codex/responses` reject a body with no `instructions` key? codex-rs omits it; codex-lb says it is required. Plan: always send `instructions` (empty string if none). Needs a live test.
4. Anthropic 429 JSON body: no real capture found. Needs one live capture of a limited account.
5. Codex redirect URI: is `127.0.0.1` registered as well as `localhost`? Matters only if a browser-redirect flow is wanted instead of device code.
6. Meaning of `anthropic-ratelimit-unified-fallback` and the `-slow-*` family. Not analysed.
7. Is the Claude access token lifetime always 8 hours? Only test fixtures show 28800 and 3600.
8. Does OpenAI treat pooled use of one ChatGPT account from several IPs as abuse? No primary source found. Needs a legal or vendor answer.
9. Whether a plain Node/Bun TLS stack passes Cloudflare on `platform.claude.com` and `api.anthropic.com` without a Firefox fingerprint (R7). Needs a live probe.

## 10. Limitations of this research

- No live request was sent. All wire details are from source code and could differ in production.
- The Claude Code values come from `strings` over a compiled binary. Minified names (`F0o`, `Ete`, `RP`) are build specific; only the constants and request shapes are relied on.
- `ccusage` and `claude-code-router` were not read; their endpoints match the files above.
- The enforcement timeline for Anthropic comes from news snippets (low-medium confidence). The policy text itself is primary.
- No OpenAI policy text on pooling was found. The "greyer area" statement is from search snippets (low).

Status: DONE_WITH_CONCERNS
