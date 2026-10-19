---
phase: 5
title: "Panel page, dialogs, Guide and API Key changes"
status: completed
priority: P1
effort: "1.5d"
dependencies: [2]
---

# Phase 5: Panel page, dialogs, Guide and API Key changes

## Goal
Build the screens of the approved mockup
([mockup/subscription-pool-mockup.html](./mockup/subscription-pool-mockup.html), part 2) with the
existing Tea components and patterns.

## Impact check (run first)
- `impact` upstream on: `ConsoleLayout` menu filter (`MemoryPanel/web/src/layouts/ConsoleLayout.tsx:138-173`),
  `PAGE_META` (`web/src/constants/menu.tsx`), `ALLOWED_PANEL_ACTIONS`
  (`MemoryPanel/src/panel/api/meta-actions.ts`), `GuidePage` manual config
  (`web/src/pages/GuidePage/index.tsx:77-100`), `ApiKeyPanel`.

## Files to Create / Modify
- Modify: `MemoryPanel/src/panel/api/meta-actions.ts` — add the `subscription-pool/*` public
  actions to `ALLOWED_PANEL_ACTIONS` (the meta proxy rejects unknown actions at
  `routes/meta/proxy.ts:159`).
- Create: `MemoryPanel/web/src/lib/api/subscription-pool.ts` — client for the actions, pattern of
  the user-key API module.
- Modify: `MemoryPanel/web/src/constants/menu.tsx` — page `subscription_pool` in group
  `organization`, order 3, icon.
- Modify: `MemoryPanel/web/src/layouts/ConsoleLayout.tsx` — path `team/subscription-pool`; show the
  item only when `userRole === 'admin'` (same rule as analytics at `:159-160`).
- Modify: `MemoryPanel/web/src/routes/index.tsx` — route `team/subscription-pool`, guarded for
  System Admin.
- Create: `MemoryPanel/web/src/pages/SubscriptionPoolPage/index.tsx` and `components/`:
  `PoolHeader` (tabs Claude Code / Codex, pool switch), `PoolSummary` (4 stats), `PoolSettings`
  (threshold, usage-check info, "Check all now"), `AccountTable` (columns: Account, Status, two
  window meters with threshold mark and reset time in local time, extra rows for per-model
  windows such as "Opus weekly" when present, "Sessions (2 days)", Updated, Actions; a
  "Usage check failing" warning when `usage_fail_count ≥ 3`),
  `AddAccountDialog` (provider-specific step 2: code for Claude, redirect URL for Codex; also used
  for Re-login), `PoolSwitchConfirmDialog` (on / off), `DeleteAccountDialog`.
  Refresh data every 60 s while the page is visible.
- Modify: `MemoryPanel/web/src/pages/GuidePage/index.tsx` (manual config `:77-100`) — switch
  "Keep my own Claude login as fallback"; when on, the Claude Code snippet uses
  `ANTHROPIC_CUSTOM_HEADERS: "x-tdai-user-key: <key>"` and no `ANTHROPIC_AUTH_TOKEN`; Codex snippet
  as confirmed in phase 0.
- Modify: `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx` — one info line with
  a link to the Guide section.
- Modify: `MemoryPanel/web/src/i18n/en-US.ts` and `zh-CN.ts` — all new strings (keys
  `menu.subscription_pool`, `subscriptionPool.*`, `guide.manual.ownLoginFallback*`,
  `apiKey.poolHint`).
- Modify: `MemoryPanel/panel-api-doc.md` — new actions.
- Create: component tests with Vitest for `AccountTable` status rendering and meter thresholds.

## Tasks & Steps
1. Run the impact check.
2. Allowlist + API client.
3. Menu, route and guard; confirm a member account does not see the item and gets redirected.
4. Page and components; match the mockup text and states (Active, Near limit, Exhausted,
   Re-login needed, Disabled, Ready (pool off), empty state).
5. Dialogs; the authorize URL opens in a new tab; the paste field accepts code or URL.
6. Guide and API Key changes.
7. i18n for both languages.

## Verification
- `cd MemoryPanel && npx vitest run` and `cd MemoryPanel/web && npm run build` pass.
- Manual check against each part-2 screen of the mockup, as System Admin and as Member.
- Network tab: no response from `subscription-pool/*` contains `access_token` or `refresh_token`.

## Risk / rollback
- UI only reads and calls Core actions; hiding the menu item removes the feature from the Panel.

## Scope after decision 33 (Codex only) — added 2026-10-19

- The Codex tab is the working pool. The Claude Code tab shows a short notice that Claude
  subscription pooling is not supported (provider terms) and has no switch or Add button.
- Add / Re-login dialog: Codex flow only (open the authorize URL in a new tab, paste the full
  redirect URL from the browser address bar, even though the page fails to load).
- Guide: the "keep my own login as fallback" switch applies to the Codex snippet
  (`requires_openai_auth = true` and `http_headers = { "x-tdai-user-key" = "<key>" }`); the Claude
  Code snippet does not change.
- Web has no test runner: put pure display logic (status label, meter level, threshold mark) in a
  `.ts` module and test it from `MemoryPanel/tests/` with the Panel Vitest.

## Results (2026-10-19)

Report: `plans/reports/fullstack-developer-261019-1456-panel-pool-ui.md`.

- Page `team/subscription-pool` (menu Organization → Subscription Pool, System Admin only; members
  are redirected). Codex tab: switch with confirm, summary, settings, account table, add /
  re-login / delete dialogs, 60-second refresh while visible. Claude Code tab: not-supported notice.
- Guide: Codex "keep my own ChatGPT login as fallback" checkbox (default off, same as the setup
  script). API Key page: hint line.
- Checks: `MemoryPanel` Vitest 45 tests pass (display logic, action allowlist); `tsc` 0 errors for
  Panel and web; `vite build` passes; no token field names in Panel files.
- Changed after the agent's report: accounts can be added before the pool is first turned on
  (Core now creates the pool group switched off; the Add button is always on), as in the approved
  mockup.
- Deviations kept: fourth summary stat "Client OAuth fallback (24h)" shows the threshold instead
  (no API gives the fallback count); settings show "Last update" only (no next-check time in the
  API); exhausted rows show the release time, not the 429 time.
- Browser check against the mockup: done in phase 7.
