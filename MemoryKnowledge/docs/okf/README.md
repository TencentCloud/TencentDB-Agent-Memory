# Native OKF 0.2 Wiki support

This fork starts from TencentCloud/TencentDB-Agent-Memory default branch
`feat/server_team`, commit `274e549069ad780e411d70e6fff51f6a977d81d3`.
The specification baseline is
[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md),
version 0.2, commit `ad30107c31c06aec8a7d5636e0d1058118604e6f`.
New specification versions require review and tests; a mutable upstream branch
is not an automatic compatibility promise.

## Storage and consumption

The existing `wiki/` tree is the authoritative content. SQLite FTS and graph
indexes are derived, rebuilt by WikiSourceManager. Native import writes the
supplied bytes and paths without calling an LLM, canonicalizing names, changing
frontmatter, or adding `locked`. Non-Markdown reference scripts and binary assets
are transported intact and never executed. No extra OKF service or duplicated
knowledge database is required.

The MCP search tool description and MemoryProxy agent guidance explain how to surface these signals without inferring verification or executing imported code.

Search results now include `okf`: original frontmatter, advisory `trust`, `status`,
`stale`, `verificationPredatesContent`, and warnings. Bare verification mappings
and verification lists are both consumed. Missing optional fields and unknown
types/extension fields remain valid. Unknown fields (including null values) are
preserved. Datetimes without an explicit UTC offset produce warnings.
`stale_after` is evaluated at query time, not cached at indexing time. Historical
verification events remain after content changes, as OKF specifies; the separate
`verificationPredatesContent` flag prevents treating them as a new confirmation.
These fields never grant access or replace existing service/team authorization.

Standard CommonMark inline and reference links resolve relative to the current
concept or bundle root. Code examples and images do not create knowledge edges.
Source resources that identify local concepts also create edges. Broken standard
links do not fall back to a different page with the same basename. Existing
`[[wikilinks]]` remain supported. `index.md` and `log.md` are reserved at every
level and excluded from concept indexing. Rebuilt root indexes declare
`okf_version: "0.2"`. The reported `page_count` counts indexed concept pages,
not reserved index/log files; an existing wiki can therefore show a lower count
after rebuilding while its stored document bytes remain unchanged.

## HTTP endpoints

All paths below are relative to the existing Wiki route mount. Supply
`x-tdai-service-id`; import/export additionally require `team_id` and `wiki_id`.
Existing resource lookup checks the service **and** team before accessing files.
Requests use the existing API response envelope.

| POST path | Body | Behavior |
| --- | --- | --- |
| `/okf/validate` | `{ "files": [...] }` | Validate without saving or invoking a model |
| `/okf/import` | `{ "team_id": "...", "wiki_id": "...", "files": [...], "overwrite": false }` | Native import, then rebuild derived indexes |
| `/okf/export` | `{ "team_id": "...", "wiki_id": "..." }` | Return `{ "files": [...] }` |

Each file is `{ "path": "nested/page.md", "content": "...", "encoding": "utf-8" }`.
`encoding` can be omitted for UTF-8; `base64` handles binary data. Export uses
base64 for every file so byte-level fidelity is explicit. Paths are relative to
`wiki/`, with no leading `wiki/`. The transport is an application API, not a new
OKF packaging standard. Use the CLI to turn a directory into this transport.

A new Wiki can be created using the existing create API, then populated with
native import without uploading raw files or calling ingest. If an index rebuild
fails after saving, the API reports this explicitly; saved content remains, and
the Wiki is marked failed until successful reindexing.

Import preflights the entire batch, stages it beside the existing directory, and
swaps directories with rollback on commit failure. It merges supplied files into
the existing tree; absent files are **not** deleted. `overwrite` must be explicit;
locked pages cannot be overwritten. Import/export refuse queued/active ingestion.
Symlinks, traversal, duplicate paths, case-insensitive/Unicode alias collisions, and file/directory collisions are rejected.
Transport limits: 1,000 files, 10 MiB decoded total. HTTP transport restricts the total payload to 20 MiB using a streaming body limiter before JSON allocation to prevent OOM attacks. Large corpora require a future
streaming transport; these endpoints are deliberately bounded. A process crash
between directory renames may leave a `wiki.okf-backup-*` sibling for recovery;
the swap is not a distributed filesystem transaction and the service does not use cross-process locking (single writer process only). Import failures report 409 for conflicts (locked/exists), 400 for validation errors, and 500 for internal failures. A committed swap is not undone merely because metadata or indexing fails; the wiki remains failed or processing until recovery succeeds.

Validation requires UTF-8 Markdown concepts with parseable YAML and a nonempty
`type`. It warns on optional-family problems, unknown future version declarations,
and log date headings. It tolerates unknown types, missing indexes and broken links.
Reserved root index frontmatter may contain only `okf_version`; nested indexes
have no frontmatter. Logs may include frontmatter, which is preserved without
classifying the reserved log files as concepts. Files outside `.md` are opaque attachments.

## Generation, merging and deletion

Generated Wiki pages use object sources, `generated` with actor `wiki-ingest/2`,
and producer-assigned times. LLM output cannot manufacture `verified` events.
LLM rewrites cannot remove authoritative existing lifecycle or extension metadata,
and the rewrite failure fallback retains both old and new bodies. Object source
metadata and stable source IDs survive merges. Optional source credibility signals
are preserved, not guessed. Attested Computation contracts are excluded from
automatic LLM merging: editing sanctioned computation code requires an explicit
write by the caller.

TencentDB's raw files are outside the Wiki bundle. A generated source uses
`resource: "raw source: nested/file.md"` (a scope descriptor allowed by OKF) and
`tdai_raw_source: "nested/file.md"` (a producer extension).
The descriptor avoids pretending that an external raw file exists at a
bundle-relative path. Cascade deletion uses this exact raw key, or a legacy
string key; it never infers deletion from an external URL's basename. Raw bytes
are not automatically copied into exports. For a self-contained source archive,
include source snapshots as typed Reference concepts or opaque attachments in
`references/` and point resources to their actual paths.

## Migration and offline use

Use Node.js 22; install dependencies using the checked-in lockfile:

```sh
cd MemoryKnowledge
npm ci
npm run typecheck
npm test
npm run build

npm run okf -- export examples/okf /tmp/okf-bundle.json
npm run okf -- validate /tmp/okf-bundle.json
npm run okf -- import /tmp/okf-bundle.json /tmp/new-wiki
npm run okf -- migrate /path/to/legacy.md /path/to/migrated.md
```

Export/migration output must be a **new** file, preserving the original for
rollback. Migration converts legacy raw source strings to source objects, keeps
unknown/control fields and preserves the body exactly. It is idempotent and refuses
lossy conversion of invalid sources. Legacy `timestamp` is retained and consumed as
a fallback when `generated` is absent. A migration does not invent the original
producer, verification, credibility signals, or a new `generated.by`.
Migration is explicit and file-based, not automatically applied to an entire
existing deployment. Review migrated copies before replacing originals.

## Attested Computation and boundaries

`runtime`, `parameters`, `computation`, `executor`, `attester` and all additional
contract data are preserved and exposed to consumers. Missing `runtime` produces
a warning. Source-footnote keys are checked for missing/duplicate attribution.
This patch does **not** execute a computation or claim that a result was attested.
OKF 0.2 deliberately defers the runner/attester ABI, receipt wire format and
sandboxing. A separate trusted runner can consume these contracts later.

Chat Memory L0–L3, skills, code graphs, authorization, task queues and execution
receipts keep their existing domain models. An OKF bundle is not a full deployment
backup: operational databases, raw input outside the bundle, user permissions,
queue state and indexes require their normal backup procedures.

## Verification

The suite exercises byte-preserving native exchange, malformed/unknown metadata,
legacy migration, source merges and deletion, standard Markdown links, locked
pages, traversal/symlink/collision handling, rollback on staging failure, plus
real SQLite FTS/graph and HTTP endpoint behavior with service/team isolation.
The additional middleware fix removes manual mutation of Hono's private body
cache; `c.req.text()` already caches the request. This fixes the upstream typecheck
failure against current Hono, and HTTP tests run through this middleware.

## Recovery of Failed Imports

If the Node process crashes or is killed during `POST /wiki/okf/import`, the Wiki may be left in an incomplete state.
The service uses an on-disk journal (`okf-journal.json`), a staging directory (`wiki.okf-stage-<UUID>`), and a backup directory (`wiki.okf-backup-<UUID>`) to support process-restart recovery. Journal rename is atomic, but there is no fsync/power-loss or cross-filesystem/SQLite transaction guarantee. Keep the data directory writable only by the trusted service account and use one writer process; filesystem checks are not a sandbox against concurrent privileged filesystem changes.

**Explicit Recovery**
There is no startup auto-recovery. The operator explicitly calls `POST /wiki/okf/recover` below the configured API prefix, supplying `Authorization: Bearer <service-key>` and `x-tdai-service-id: <service-id>` headers and a JSON body containing `team_id` and `wiki_id`.
Automatic recovery via this endpoint is strictly limited to the validated **indexing** phase (when the file swap succeeded, but metadata indexing or SQLite updates failed). During this phase, recovery will attempt to rebuild derived indexes and update the metadata database. The backup is safely cleaned up only after successful indexing and metadata updates.

An unresolved journal blocks a new import and ordinary ingestion/sync until recovery or deliberate operator reconciliation has completed.

If active unrelated ingestion is occurring for the wiki, recovery returns HTTP `409 Conflict`. If the wiki belongs to a foreign team, it returns HTTP `404 Not Found`. Repeated calls after successful finalization return HTTP `200 OK` as a no-op without reindexing or incrementing the version. The OKF import/recovery HTTP paths, indexing status and audit-write failure messages use fixed internal-error text. This is not a global log-redaction guarantee for unrelated application paths.

**Operator Intervention (Ambiguous States)**
If a crash occurs during the **started** phase, or if the live Wiki directory cannot be unambiguously identified, the API will refuse to modify files and will return a `500` error indicating that operator intervention is required. The journal, stage, and backup directories are deliberately preserved as evidence.

To manually recover an ambiguous import:

1. **Stop all writers** to the service.
2. **Take an offline copy** of the complete wiki directory and the metadata database before any inspection or modification.
3. **Preserve** all `okf-journal.json`, `wiki.okf-stage-<UUID>`, and `wiki.okf-backup-<UUID>` evidence.
4. Perform deliberate operator reconciliation of the native files, the database version, and derived indexes. There is no automated reconciliation for these ambiguous states.
5. **Never** simply delete the backup/journal first, or manually set the database `status=ready` without performing complete reconciliation of the data and indexes.

## MCP stdio Server Configuration

The stdio MCP server (`bin/mcp.mjs` / `dist/mcp/server.mjs`) provides 12 query tools over standard input/output for LLM agents.
Because all Knowledge wiki and code-graph endpoints enforce multi-tenant authorization (`x-tdai-service-id`), the MCP CLI requires configuring the service tenant identifier via the environment:

- `KNOWLEDGE_API_URL`: Base URL of the running Knowledge HTTP backend (default: `http://localhost:8421`).
- `KNOWLEDGE_SERVICE_ID`: Service tenant identifier propagated as the required `x-tdai-service-id` header to backend API calls. Must be a valid identifier segment matching `^[A-Za-z0-9_-]+$` (1–200 characters). Queries without a matching tenant service ID are rejected (HTTP 400 if omitted, HTTP 404 if referencing another tenant's resource).
- `KNOWLEDGE_API_TOKEN` / `KNOWLEDGE_SERVICE_KEY`: Bearer token forwarded for service authorization (required when the backend has a service key) (`Authorization: Bearer <token>`).

Example execution:
```sh
KNOWLEDGE_API_URL=http://127.0.0.1:8421 \
KNOWLEDGE_SERVICE_ID=my-service-tenant \
KNOWLEDGE_SERVICE_KEY=my-service-key \
node bin/mcp.mjs
```

The MCP client currently targets the default `/v3` API prefix. Configure one service tenant per MCP process; the shared service key does not authenticate individual end users. Place user-facing access behind a trusted authorization gateway.
