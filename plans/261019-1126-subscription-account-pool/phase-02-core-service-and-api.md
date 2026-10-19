---
phase: 2
title: "Core service and API"
status: completed
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: Core service and API

## Goal
Expose System-Admin APIs for the Panel and internal APIs for the Proxy, reusing the upstream group
service, its authorization and its masking.

## Impact check (run first)
- `impact` upstream on: `MetadataService.assertModeForGroupType` (`metadata-service.ts:2600`),
  `MetadataService.updateInstanceUpstreamGroup` (`:2288`), `MetadataService.listInstanceUpstreamGroupsInternal`
  (`:2235`), `MetadataService.toPublicGroup` (`:2621`), `MetadataService.translateUpstreamConflict` (`:2651`).

## Files to Create / Modify
- Modify: `MemoryCore/src/metadata/service/metadata-service.ts` — allow `subscription_pool` for
  `custom` groups; add a new service section (or file `subscription-pool-service.ts` if the
  service class grows past readability) with the methods below.
- Modify: `MemoryCore/src/metadata/router/v3-meta-schemas.ts:460` — `upstreamMode` enum adds
  `subscription_pool`; new Zod schemas for every action below.
- Modify: `MemoryCore/src/metadata/router/v3-meta-router.ts` (next to `:390-430`) — public routes,
  each guarded by `assertCanManageUsers` (System Admin), like the group routes.
- Modify: `MemoryCore/src/metadata/router/internal-meta-router.ts` (next to `:103`) — internal routes
  for the Proxy (service-token auth already applied by the gateway, `:159`).
- Modify: `MemoryCore/v3-api-memorycore-doc.md` — document the new actions.
- Create: tests next to existing instance-upstream service and router tests.

## Public actions (`POST /v3/meta/subscription-pool/...`, System Admin only)
| Action | Purpose |
|---|---|
| `status` | Per agent (`claude-code`, `codex`): pool on/off, group id, settings, accounts (masked: no tokens), summary counts (available, active sessions from the last proxy report, earliest reset) |
| `enable` | One transaction: create the `custom` group `subscription_pool` for the agent if missing, move the agent out of its current group (`default` or another), set `enabled=1`. Fails with a clear error if the agent is in a `custom_*` group, so the admin does not lose a custom setup by mistake |
| `disable` | One transaction: move the agent back to the `default` group; keep the pool group and accounts |
| `settings/update` | `threshold_pct` 50–100, stored with the existing ConfigParam service (`meta_config_params`, global scope, module `subscription_pool`) |
| `account/oauth-start` | Create PKCE verifier + state (kept 10 min in memory or a short-lived table); return the authorize URL |
| `account/oauth-complete` | Input: state + code (Claude) or full redirect URL (Codex); exchange in phase 3 adapter; create or re-login the account |
| `account/update` | Rename, enable / disable |
| `account/delete` | Delete the account and its tokens |
| `account/check-usage` | Run one usage check now (phase 3 job function) |
| `check-all` | Run usage checks for every account now |

## Internal actions (`POST /v3/internal/meta/subscription-pool/...`, Proxy service token)
| Action | Purpose |
|---|---|
| `accounts/list` | Pool groups with eligible-account data for the Proxy: id, provider, status, enabled, access token, `provider_account_id`, usage snapshot, `exhausted_until`, threshold |
| `report` | Proxy reports `{account_id, windows[], status_code, retry_after?, active_sessions}`; Core updates the snapshot, sets `exhausted_until` on 429, schedules a check at reset |
| `refresh` | Proxy asks for a fresh access token after a 401; Core refreshes under a per-account lock and returns the new token |

## Tasks & Steps
1. Run the impact check.
2. Extend the mode enum in Zod and service; existing modes keep their rules. A
   `subscription_pool` group has no `base_url` (each provider has a fixed endpoint), so skip the
   `MISSING_BASE_URL` check (`metadata-service.ts:2259`) and the `MISSING_API_KEY` check for this
   mode only; reject a non-empty `base_url` / `api_key` for it.
3. Implement `enable` / `disable` with the existing store transaction helper so that the "one
   agent in one group" rule (`translateUpstreamConflict`, agents overlap) can never fail halfway.
4. Implement masked account output with a `toPublicAccount` function next to `toPublicGroup`.
5. Implement internal actions; `accounts/list` returns only enabled groups in mode
   `subscription_pool`.
6. Tests: authorization (member gets 403), enable/disable round trip keeps the old default group
   untouched, masking (no `access_token` / `refresh_token` key in any public response), report on
   429 sets `exhausted_until`.

## Verification
- `cd MemoryCore && npx vitest run src/metadata` passes.
- `grep -rn "refresh_token\|access_token" MemoryCore/src/metadata/router` shows them only in the
  internal router and schemas, not in public responses.

## Risk / rollback
- Disable the feature by turning the pool off; the agent returns to `default`. Code rollback
  leaves the extra table and column unused.
