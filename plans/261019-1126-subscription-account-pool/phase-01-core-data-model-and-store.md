---
phase: 1
title: "Core data model and store"
status: completed
priority: P1
effort: "1d"
dependencies: [0]
---

# Phase 1: Core data model and store

## Goal
Add the `subscription_pool` mode to upstream groups and a new account table, in both the sqlite
and MongoDB stores, without changing the behavior of existing groups.

## Existing defect to fix first (verified by reading code)
`SqliteMetadataStore.init()` calls `createSchema()` on every process start
(`MemoryCore/src/metadata/store/sqlite-adapter.ts:115-126`), and `createSchema()` runs
`DROP TABLE IF EXISTS meta_instance_upstream_config` before `CREATE TABLE`
(`sqlite-adapter.ts:344-364`) with no guard. Result: in sqlite mode (the default deploy) every
Memory Core restart deletes all upstream groups; `ensureDefaultSeeded` then re-creates only the
`default` group. Custom groups — and the new pool groups — are lost. The MongoDB adapter has no
such drop.

Fix: run the drop only once, when the table still has the old v1 shape (for example, when
`PRAGMA table_info(meta_instance_upstream_config)` has no `group_id` column); otherwise use
`CREATE TABLE IF NOT EXISTS`. Add a regression test: insert a custom group, close the store, open
it again, the group is still there.

## Impact check (run first)
- `impact` upstream on: `SqliteMetadataStore.createInstanceUpstreamGroup`,
  `SqliteMetadataStore.updateInstanceUpstreamGroup`, `MongoMetadataStore.createInstanceUpstreamGroup`,
  `MongoMetadataStore.mapMongoGroup`, `InstanceUpstreamConfigEntity`, `UpstreamMode`.

## Files to Create / Modify
- Modify: `MemoryCore/src/metadata/types.ts:611` — add `"subscription_pool"` to `UpstreamMode`;
  add `SubscriptionAccountEntity`,
  `SubscriptionProvider = "claude" | "codex"`, `SubscriptionAccountStatus =
  "active" | "exhausted" | "auth_error" | "disabled"`.
- Modify: `MemoryCore/src/metadata/store/interface.ts:251-270` — declare account CRUD methods:
  `listSubscriptionAccounts(groupId?)`, `getSubscriptionAccount(id)`,
  `upsertSubscriptionAccountByProviderId`, `updateSubscriptionAccount(id, patch, expectedVersion?)`,
  `deleteSubscriptionAccount(id)`. No "due for check" query: scheduling is in memory (ADR 0001).
- New code lives under `subscription-pool/` modules; core files get small hooks only (fork
  strategy, decision 20).
- Modify: `MemoryCore/src/metadata/store/sqlite-adapter.ts` — guard the v1 drop (see above);
  CHECK constraint on `mode` at `:354` adds `'subscription_pool'`; new
  `migrateSubscriptionPool()` called after `migrateUserTypeColumn()` / `migrateLegacyUserKeys()`
  (`:370-371`, the existing post-`createSchema` migration hook, which inspects columns with
  `PRAGMA table_info` before it alters): if the table's CHECK constraint lacks
  `subscription_pool` or the `settings` column is missing, rebuild the table inside
  `withImmediateTx` (create new, copy rows, swap); create table
  `meta_upstream_subscription_account` with `CREATE TABLE IF NOT EXISTS`; implement the store
  methods.
- Modify: `MemoryCore/src/metadata/store/mongodb-adapter.ts` — same methods, collection
  `meta_upstream_subscription_account`, indexes on `account_id` (unique) and `group_id`;
  `mapMongoGroup` (`:2058`) maps `settings`.
- Create: `MemoryCore/src/metadata/store/subscription-account.test.ts` (sqlite) and a Mongo test
  next to existing Mongo adapter tests if present.

## Table `meta_upstream_subscription_account`
| Column | Type | Notes |
|---|---|---|
| `account_id` | TEXT PK | `sacc-` + random |
| `group_id` | TEXT NOT NULL | FK to `meta_instance_upstream_config.group_id` |
| `provider` | TEXT | `claude` \| `codex` |
| `display_name` | TEXT | unique per group |
| `account_label` | TEXT | e-mail and plan from the ID token / profile, for display only |
| `enabled` | INTEGER | admin switch |
| `status` | TEXT | `active` \| `exhausted` \| `auth_error` \| `disabled` |
| `access_token`, `refresh_token` | TEXT | plaintext (decision 5); never returned by public APIs |
| `token_expires_at` | INTEGER ms | |
| `provider_account_id` | TEXT | provider-side identity (Claude account UUID / e-mail, Codex `chatgpt-account-id`); unique per group — adding the same account again replaces the tokens of the existing row |
| `usage_json` | TEXT | `{windows:[{name, model_scope?, used_pct, resets_at, observed_at, source}]}` — every Quota Window the provider returns, including per-model windows; newest observation per window wins, a 429 sets `used_pct=100` until reset |
| `usage_updated_at` | INTEGER ms | |
| `exhausted_until` | INTEGER ms | set on 429; "Exhausted" is computed as `now < exhausted_until` at read time |
| `usage_fail_count` | INTEGER | consecutive usage-API failures; Panel warns at ≥ 3 |
| `refresh_fail_count` | INTEGER | consecutive transient refresh failures |
| `last_error` | TEXT | short message, no token |
| `version` | INTEGER | optimistic lock |
| `created_at`, `updated_at` | TEXT | |

The pool threshold is not stored on the group. It lives in the existing ConfigParam store (`meta_config_params`, scope `global`, module `subscription_pool`, param `threshold_pct`, default 95); metadata is per instance, so this is one setting per instance. Reason: adding a field to `InstanceUpstreamConfigEntity` had HIGH/CRITICAL GitNexus impact.

## Tasks & Steps
1. Run the impact check. Record results in the phase notes. Fix the restart drop first, with its
   regression test, as a separate commit (`fix(memory-core): keep upstream groups across restart`).
2. Back up a local sqlite volume; run the migration on a copy of a real `metadata.db`; confirm
   existing rows keep `mode`, `api_key` and `agents`.
3. Implement types, interface, sqlite and Mongo methods.
4. `assertModeForGroupType` stays unchanged in this phase (phase 2 allows the new mode).
5. Write tests: migration on an old schema, CRUD, version conflict, cascade delete when a group is
   deleted.

## Verification
- `cd MemoryCore && npx vitest run src/metadata` passes, including existing instance-upstream tests.
- Migration test opens a database created with the old schema and reads all old rows unchanged.

## Risk / rollback
- Changing a CHECK constraint in sqlite needs a table rebuild. Do it inside one transaction; the
  old table stays until the copy succeeds. Rollback: restore the backup.
