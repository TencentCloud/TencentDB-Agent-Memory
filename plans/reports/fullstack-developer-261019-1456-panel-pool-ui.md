# Panel pool UI report (Codex-only scope)

Status: DONE_WITH_CONCERNS. Nothing committed. Only files under MemoryPanel/ and this report were touched.

## Verification (real output)
- `cd MemoryPanel && npx vitest run`: 2 files, 45 tests passed (34 display logic, 11 allowlist).
- `cd MemoryPanel && npx tsc --noEmit`: exit 0, 0 errors.
- `cd MemoryPanel/web && npx tsc --noEmit -p .`: exit 0, 0 errors.
- `cd MemoryPanel/web && npx vite build`: `built in 3.22s` (only the existing chunk size warning).
- grep for `access_token` / `refresh_token` in every file I wrote or changed: no match.
- Tests were written first and failed (module missing) before the display module was added.

## GitNexus impact (upstream)
- ConsoleLayout LOW (1 direct: routes/index.tsx); usePageMeta LOW (ConsoleLayout, TabBar); PageId LOW; ITEM_ICON LOW; PATH_TO_PAGE LOW.
- ALLOWED_PANEL_ACTIONS LOW, META_ACTIONS LOW, MetaAction LOW; text search: only `src/panel/http/routes/meta/proxy.ts:159` reads the set.
- ApiKeyPanel LOW (0 callers); MANUAL_IDES LOW (0 callers).
- `PAGE_META` not found (it is a local value in ConsoleLayout); resolved by text search to ConsoleLayout and TabBar. `routes` and `GuidePage` returned UNKNOWN; text search shows `routes` is read by App only and `GuidePage` is imported only by `routes/index.tsx`.
- No HIGH or CRITICAL result.

## Files
Created: `web/src/lib/subscription-pool-display.ts` (pure logic), `web/src/lib/api/subscription-pool.ts` (client; account type has no token fields), `web/src/pages/SubscriptionPoolPage/{index.tsx,style.css,use-pool-status.ts,pool-errors.ts}`, `components/{PoolHeader,PoolSummary,PoolSettings,AccountTable,AddAccountDialog,PoolSwitchConfirmDialog,DeleteAccountDialog}.tsx`, `tests/subscription-pool-display.test.ts`, `tests/subscription-pool-actions.test.ts`.
Modified: `src/panel/api/meta-actions.ts` (10 actions), `web/src/constants/menu.tsx`, `layouts/ConsoleLayout.tsx`, `routes/index.tsx`, `i18n/en-US.ts` + `zh-CN.ts` (129 keys each), `pages/GuidePage/index.tsx` + `style.css`, `pages/ApiKeysPage/components/ApiKeyPanel.tsx`, `panel-api-doc.md` (Chinese, like the rest of that file).

## Behavior
- Menu item and route `team/subscription-pool` (group Organization, order 3). Menu filter shows it only for `admin`. The page returns null while the role is unknown and redirects to `/` when the role is not admin. The tab bar also hides the tab for non-admin.
- Codex tab: header with Pool switch (confirm dialog on and off), 4 stats, settings (threshold 50-100, Check all now), account table, add / re-login dialog, delete dialog. Claude Code tab: warning notice only, no switch, no Add.
- Add dialog: oauth-start on open, authorize URL opened with `window.open(..., 'noopener,noreferrer')`, one paste field (full redirect URL or a bare code), expiry time shown. `INVALID_OAUTH_STATE` and `OAUTH_EXCHANGE_FAILED` switch the footer to "Start again".
- Data refresh every 60 s only while `document.visibilityState === 'visible'`; hidden tab stops the timer; becoming visible refreshes at once. A request counter drops out-of-order responses.
- Display rules (all in the .ts module and tested): window with `resets_at <= now` shows 0 % and "reset"; exhausted only while `exhausted_until > now` (or status exhausted with no release time); precedence disabled > re-login > exhausted > near limit > active; "Ready (pool off)" for active accounts when the pool is off; usage check failing at `usage_fail_count >= 3`; local-time reset text ("15:10" same day, "Thu 08:30" other day) and remaining time ("2d 21h", "3h 40m", "36m").
- Guide: for Codex only, checkbox "Keep my own ChatGPT login as fallback". On: `requires_openai_auth = true` plus `http_headers = { "x-tdai-user-key" = "<key>" }` replace `experimental_bearer_token`. Claude Code snippet unchanged.
- API Key page: one info line with a link to /guide.

## Assumptions and deviations from mockup / phase file
1. Core error identifiers are at the start of the envelope `message` ("POOL_NOT_ENABLED: ..."); the envelope `code` is only the HTTP status. The Panel parses the prefix (`parsePoolErrorCode`, tested) and maps it to localized text. Core's stale-write code for `expected_version` is `version_mismatch` (not the `WRITE_CONFLICT` I first guessed); both stale codes refresh the list.
2. Add account is disabled until the pool group exists (`group_id` is null before the first enable), because Core answers `POOL_NOT_ENABLED` otherwise. The mockup says accounts can be added while the pool is off; that works after the first time the pool was turned on. The page shows a hint for the never-enabled case.
3. Fourth stat "Client OAuth fallback (24h)" is dropped: no API returns it. Replaced with the threshold. "Last: / Next:" in settings became "Last update" only (newest `usage_updated_at`); Core exposes no next-check time.
4. Meter colors: ok below 70 % (or below the threshold when it is lower), warn from 70 % to 99 %, full at 100 %. This is my choice taken from the mockup examples (61 % ok, 77 % warn, 100 % full).
5. Near limit uses shared windows only; per-model windows are shown as extra rows (indented "name (scope)") but do not set the row status.
6. Window columns key off Core's Codex names `primary_window` / `secondary_window`; five_hour / seven_day are also accepted. Any other shared window becomes an extra row with its raw name.
7. Disable sends only `enabled: false` with `expected_version`; Enable also sends `status: 'active'` when the stored status is `disabled`.
8. Re-login uses the normal add flow (Core matches by provider account id), with no name field. Exhausted rows show the auto-release time instead of "429 at HH:mm" (no 429 time in the public shape).
9. Mockup warning "Codex may not send its own ChatGPT login" is kept; the Guide hint says the fallback is used only when the pool is exhausted.
10. ApiKey hint says ChatGPT/Codex (the mockup said Claude) because of the Codex-only scope.
11. No component-render tests (Panel Vitest is node-only, no DOM); only the pure logic and the allowlist are tested. No browser run was possible here, so the manual mockup comparison as Admin and Member is not done; type check and build pass.
12. Scripts `setup-proxy.sh` and the setup Skill are outside Panel and were not touched.

## Unresolved questions
- Should the Codex fallback checkbox default to on when the pool is on? It defaults to off to keep the old snippet.
- GitNexus `detect_changes` was not run (no commit made); run it before committing.

Status: DONE_WITH_CONCERNS
