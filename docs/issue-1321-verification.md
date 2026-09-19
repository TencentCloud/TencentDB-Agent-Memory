# Issue #1321 — verification record

Baseline commit: `41dee1f` (`feat/server_team` lineage).
Task branch: `fix/issue-1321-orphan-agent-lifecycle`.

## Observed results (2026-09-19)

| Check | Command (run in indicated package) | Observed result | Exit |
|---|---|---|---|
| Original implementation + initial regression snapshot, MemoryCore | `npm test -- src/metadata/__tests__ --testTimeout=3000` | **19 failed / 66 passed**, 85 total | 1 |
| Modified implementation, MemoryCore | `TEST_METADATA_MONGODB=1 npm test -- src/metadata/__tests__` | **183 passed**, 7 files | 0 |
| Same service lifecycle suite on real MongoDB, MemoryCore | `TEST_LIFECYCLE_BACKEND=mongodb npm test -- src/metadata/__tests__/agent-lifecycle.test.ts` | **38 passed** | 0 |
| Panel routing + Agent UI permission matrix | `npm test -- tests/lifecycle` | **14 passed** | 0 |
| Panel TypeScript | `npm run typecheck` | no errors | 0 |
| Frontend typecheck + Vite build, MemoryPanel/web | `npm run build` | built; existing large-chunk warning | 0 |
| Core plugin bundle (isolated container copy) | `npm run build:plugin` | build complete | 0 |
| Core strict TypeScript, baseline vs modified | command below | **557 → 557** diagnostics; zero added after normalizing checkout path and source line numbers | 2 / 2 |

The MongoDB service run repeats the same 38 assertions on a different backend;
it is not 38 additional distinct feature scenarios. MongoDB tests launch their own
disposable replica sets. HTTP tests bind disposable loopback ports and use generated
fixture users. The configured deployment's business data/API credentials are not used.

## Strict TypeScript baseline

The repository has no root MemoryCore tsconfig. The following deliberately strict
command was run identically against original and modified copies using the deployed
container's installed dependencies:

```sh
./node_modules/.bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext \
  --target ES2022 --strict --skipLibCheck --noUncheckedIndexedAccess \
  src/metadata/service/metadata-service.ts \
  src/metadata/store/sqlite-adapter.ts \
  src/metadata/store/mongodb-adapter.ts src/gateway/server.ts
```

This is **not** a claim that the whole repository typechecks cleanly. Existing
issues include missing `IMetadataStore` type imports, legacy status types and
unrelated dependency typing. No broad unrelated type cleanup is included.

## Evidence coverage

- owner / team admin / non-team system admin successes and negative permission cases;
- 205-Agent actual cross-page cleanup and 205-orphan preview pagination;
- cross-team preservation, user-key deletion, team-owner/last-system-admin protection;
- parent preservation on content failure / partial batch failure and real retry;
- agent/team metadata rollback using SQLite triggers and MongoDB transaction failure;
- ownership CAS, destination validity, old-owner rejection, self-memory/owned Skill
  metadata transfer without changing borrowed assets;
- GC default preview, explicit bounded apply, healthy/stale candidate recheck;
- serialized late clone versus membership removal;
- actual HTTP 401/403/409 behavior, private read/list totals;
- real SkillCore versions and real local files, including strict resource-cleanup
  failure and successful retry (not merely a mocked cleanup callback).

## Honest limits

See [design and limitations](issue-1321-agent-lifecycle.md). The lifecycle queue
is process-local, not distributed; external content cleanup and metadata are not
one global transaction. No live multi-pod ingestion or remote object-store outage
was simulated. Full deployment was not restarted. Code rollback does not restore
business content deleted by a lifecycle operation.

The accompanying artifact bundle contains original-source backup, patch, modified
sources, exact raw command logs/exit statuses, file hashes and a guarded rollback
script. Patch apply and rollback are exercised on disposable copies, not on the
working implementation or deployment.
