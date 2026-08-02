# sqlite-vec 0.1.7-alpha.2 → 0.1.9 (wave tdai-memory-subagents-2026-08-02, P8)

> Fixes the vec0 DELETE regression #274 (vec0 text columns > 12 chars —
> exactly our `record_id` / `updated_time` / `recorded_at` columns). 0.1.9 is
> the latest stable; 0.1.10 is alpha-only and deliberately NOT used.

## Procedure (executed 2026-08-02 by the B4 executor)

1. **Snapshot vectors.db BEFORE the bump** (required — `git checkout` cannot
   roll back the vec0 schema/data: the schema lives inside the DB, not in code):
   - `~/.pi/agent-memory/tdai/vectors.db` → `vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331`
   - `~/.memory-tencentdb/memory-tdai/vectors.db` → `vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331`
   (cp -p, done before any dependency change).
2. `npm install sqlite-vec@0.1.9 --save-exact` — updates `package.json` (the
   pin lands in the commit) + `node_modules`. `package-lock.json` is gitignored.
3. KNN-sanity on a COPY of the live vectors.db (the live files are never
   opened for write): count-check (`l1_records` vs `l1_vec_rowids`) + a real
   top-3 KNN query under sqlite-vec 0.1.9 → passed (sample row `m_1785…` with
   distances 0.0000/0.0169/0.0199).
4. Store-level verification on a FAKE instance (vitest,
   `src/core/store/reindex-integration.test.ts`): vec0 DELETE+INSERT on text
   columns > 12 chars (#274 case), count-check, KNN-sanity, pin assertion.

## Rollback of the pin (documented)

`git checkout` will NOT restore the vec0 schema/data. Rollback procedure:

1. `git revert` / restore `package.json` to `sqlite-vec@0.1.7-alpha.2`
   (or `git checkout <prev-sha> -- package.json`).
2. `npm install` (re-pin node_modules).
3. Restore the pre-bump snapshot of each memory tree:
   - `cp ~/.pi/agent-memory/tdai/vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331 ~/.pi/agent-memory/tdai/vectors.db`
   - `cp ~/.memory-tencentdb/memory-tdai/vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331 ~/.memory-tencentdb/memory-tdai/vectors.db`
4. `systemctl --user restart tdai-gateway.service`; `curl /status` → `"status":"ok"`.

## Post-upgrade checks (after any gateway restart)

- `GET /memory/validate` → `vecMeta.consistent` (count-check).
- `POST /recall` with a known query → non-empty (KNN reads the vec0 tables).

## Cleanup interaction note

The snapshots above live in the dataDir root. `memory.cleanup.paths` is
dataDir-relative and default `["logs"]` — the root (and therefore the
snapshots) is never swept. Do NOT configure `memory.cleanup.paths` to `"."` or
the dataDir root, or the rollback snapshots would be age-removed by P11a.
