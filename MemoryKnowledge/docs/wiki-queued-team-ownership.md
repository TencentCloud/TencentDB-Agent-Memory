# Wiki ownership checks for queued automatic synchronization

A Wiki synchronization target captures its team when scanned. If the Wiki is reassigned or deleted before a worker consumes that target, the old worker previously read the resource credential. The importer looked up the current Wiki by service and ID but could still invoke its provider with the old team context.

The scheduler now revalidates the current team before credential access. The importer also refuses a mismatched team before provider lookup/context creation. A stale target is skipped; the next scan can synchronize the current owner normally. There are no schema or production data migrations and no new runtime dependencies.

## Validation

`tests/wiki-team-transition.test.ts` exercises the real scheduler scan and worker with fake timing, native in-memory SQLite, the real resource credential store and the real importer. The external provider and file writer are synthetic spies; the test makes no network or model calls. It covers unchanged ownership, queued A-to-B reassignment (including a fresh B scan), deletion and direct importer invocation with a stale team.

On Linux/Node 22, the unpatched complete source 42f5dce and upstream 6a4bb55 each fail three cases and pass the unchanged-owner control. The patch passes all four cases on each source. Run with the existing test tooling: `vitest run tests/wiki-team-transition.test.ts --maxWorkers=1 --no-file-parallelism`. Upstream does not currently declare Vitest in its package manifest; validation used a prepared dependency image with Vitest 4.1.11 and native SQLite, without installing or changing project dependencies. Reproducing the test requires a compatible Vitest installation.

Full upstream type checking with the prepared dependencies reports seven existing `simple-git` TS2349 diagnostics. The diagnostics are byte-identical before and after this patch; this is not a full typecheck pass.

## Scope limits

The transition is injected through SQLite to reproduce scheduling state; this does not establish an unauthorized transfer API or a remotely exploitable disclosure. The provider receives no actual secrets and no production data is mounted. This guard covers ownership changes before task execution; it does not make later asynchronous provider operations atomic with concurrent reassignment. It does not replace independent review, disaster recovery or a production rollback test.
