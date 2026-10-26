# AGENTS.md — v2→v3 data migration

Migrates MemoryCore data format v2 (v1.x/v0.x gateway data) to v3 (v2.0.0+ gateway). Idempotent, backup-first, L2/L3 copied never moved.

## OVERVIEW

Single script `v2-to-v3-migrate.py` (Python ≥ 3.8, stdlib only) upgrades `vectors.db` schema (tenant isolation) and re-homes L2/L3 files under `profiles/`. Canonical doc is `README.md` here; root `MIGRATION v2 v3.md` / `M9igrate.md` are copies.

## WHAT GETS MIGRATED

| Source | Change |
|---|---|
| `l1_records`, `l0_conversations` | + `team_id`, `task_id`, `user_id`, `agent_id` (+ `version` on l1) |
| `l1_fts` / `l0_fts` | FTS5 indexes rebuilt with isolation columns |
| `memory_audit`, `skills`, `skill_fts` | new tables |
| `scene_blocks/`, `persona.md`, `.metadata/` | copied to `profiles/team%3Adefault%7Cagent%3Adefault/` |

## COMMANDS

```bash
python v2-to-v3-migrate.py /path/to/memory-tdai --dry-run   # always first
python v2-to-v3-migrate.py /path/to/memory-tdai             # run (auto .bak)
python v2-to-v3-migrate.py /path/to/memory-tdai --db-only   # schema only
```

## RULES

- Dry-run first, always; run **before** starting the new gateway, never against a live data dir.
- Fresh installs skip this entirely (gateway creates v3 natively).
- Rollback = restore `vectors.db` from `.bak.{timestamp}`; L2/L3 sources are untouched originals.
- Re-runs safe (existing columns/files skipped).

## NOTES

- Default data dir `~/.memory-tencentdb/memory-tdai` (override `TDAI_DATA_DIR` on gateway side).
- `README_CN.md` mirrors `README.md`; keep both in sync when changing flags.
