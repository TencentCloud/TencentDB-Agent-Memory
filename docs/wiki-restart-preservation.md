# Preserve existing Wiki content during startup

Startup previously called producer initialization for every ready Wiki. This
writes missing `index.md`, `schema.md` and `purpose.md` templates. Restarting a
Wiki with its own index and pages could add files the owner never supplied.
Missing `wiki/` content could be replaced with a manufactured template tree.

The module now registers and indexes existing content without producer
initialization. Explicit ingestion still initializes its producer project.
There is no API, configuration, dependency or database migration. Build and
restart Knowledge using the normal installation procedure. Existing extra
templates are retained; review unwanted files separately before removing them.

Two Linux regression cases execute the real module, SQLite store and Wiki index.
They check repeated startup preserves the entire inventory and exact Markdown
and binary bytes while rebuilding a usable index, and missing content is not
replaced with templates. Both fail on unchanged upstream and pass with the fix.
They use synthetic data without calling a model.

The prepared Node 22 dependency fixture builds the application. Whole-source
compiler output has the same eight existing diagnostic lines before and after:
one Hono response type diagnostic and seven SimpleGit import call diagnostics.
The fixture uses SimpleGit 4; it is not a fresh installation of upstream's
SimpleGit 3 dependency range. No clean whole-upstream typecheck or independent
security audit is claimed.

To reproduce with the project's installed development dependencies:

```sh
cd MemoryKnowledge
npm ci
npm test -- tests/wiki-restart-preservation.test.ts
npm run typecheck
npm run build
```

This does not restore absent files, coordinate multiple writers, implement
disaster recovery or change the database status policy for a missing Wiki tree.
Keep backups and verify recovery and rollback procedures separately.
