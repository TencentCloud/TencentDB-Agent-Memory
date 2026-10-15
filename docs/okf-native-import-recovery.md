# Native Wiki import and interrupted-import recovery

Import native OKF bundles into an existing Wiki, preserve file bytes, build the
local derived index and retry interrupted indexing conservatively. These paths
never call the model worker, execute imported resources, convert other formats,
inject frontmatter or rewrite filenames. Actor/trust semantics and the separately
proposed preflight/export HTTP APIs remain independent features.

## Installation and configuration

Use Linux, Node.js 22 and the existing native SQLite build prerequisites. From
the proposed feature checkout:

```sh
cd MemoryKnowledge
npm ci
npm run build
export KNOWLEDGE_SERVICE_KEY="$(openssl rand -hex 32)"
export KNOWLEDGE_DATA_DIR="$PWD/data"
export KNOWLEDGE_DB_PATH="$PWD/data/knowledge.db"
export PORT=8421
node dist/server.mjs
```

The proposal retains upstream dependencies and adds no metadata schema migration.
These are normal installation instructions; recorded tests use prepared Linux
dependencies, not a fresh upstream dependency installation. Dependency updates
and Hono body-cache compatibility have separate proposals and need their own
release validation. Restart after source/configuration changes.

`API_PREFIX` defaults to `/v3`. Preserve the configured data root and SQLite
metadata together across restarts. The service creates/resolves the data root to
an absolute real path. Staging and backup directories are siblings of the Wiki
and must be on the same filesystem for rename. Budget space for the existing
Wiki, its staged copy and a retained backup.

Both operations locally require a nonempty `KNOWLEDGE_SERVICE_KEY` and matching
Bearer credential, including without outer middleware. An empty key disables
them with 503; missing/wrong credentials return 401. Legacy routes retain their
auth policy. A shared key is a service-admin credential, not a cryptographic
binding to a team: protect mutually untrusted callers with a trusted gateway
and separate identity/authorization controls.

## API and examples

All requests use `Authorization: Bearer …`, `Content-Type: application/json` and
`x-tdai-service-id`. Service, team and Wiki IDs must be safe segments. Both
operations resolve the exact existing service/team/Wiki tuple before filesystem
mutation; foreign/missing tuples return 404. Responses use the existing
`{ code, message, data }` envelope.

Create a Wiki through the existing `/v3/wiki/create` operation first. Replace the
example identifiers with that result and save this as `bundle.json`:

```json
{
  "team_id": "example-team",
  "wiki_id": "wiki-existing",
  "overwrite": false,
  "files": [
    {"path": "index.md", "content": "---\nokf_version: \"0.2\"\n---\n# Index"},
    {"path": "fact.md", "content": "---\ntype: concept\n---\nA fact"},
    {"path": "opaque.bin", "content": "AP8=", "encoding": "base64"}
  ]
}
```

```sh
curl --fail-with-body http://127.0.0.1:8421/v3/wiki/okf/import \
  -H "Authorization: Bearer $KNOWLEDGE_SERVICE_KEY" \
  -H 'x-tdai-service-id: example-service' \
  -H 'Content-Type: application/json' --data-binary @bundle.json
```

### POST /v3/wiki/okf/import

The body contains `team_id`, `wiki_id`, `files` and optional boolean `overwrite`
(default false). Success returns a report with `files`, `concepts` and advisory
`warnings`. Encoding is UTF-8 by default or base64 for binary bytes. Concepts
need mapping YAML frontmatter with a nonempty string `type`; unknown types are
accepted. Root `index.md` permits only `okf_version` metadata and unknown versions
warn. This exchange preflight is not exhaustive validation of every evolving
OKF specification rule.

The incoming bundle contains 1–1000 files and at most 10 MiB decoded content.
Actual streamed UTF-8 JSON is capped at 20 MiB even without a correct declared
length. Paths reject traversal, hidden segments, backslashes, colons, controls,
lone UTF-16 surrogates, duplicate/case/NFC aliases and file/directory collisions.
Valid astral characters and the actual replacement character remain supported.
Checked project trees must not contain links or special filesystem entries.

Import merges into a staged copy: omitted files remain. Existing entries require
`overwrite: true`; locked Markdown pages remain protected even then. Precommit
failure preserves old Wiki bytes. A successful directory swap increments the
version once and indexes without an LLM. A successful HTTP response requires indexing and
recovery finalization. A process interruption can leave ready metadata with a
journal still present; its mutation guard remains active until recovery. An unresolved journal blocks ordinary ingestion, raw/page
mutation and deletion so recovery evidence is retained.

### POST /v3/wiki/okf/recover

Send `{"team_id":"example-team","wiki_id":"wiki-existing"}` with the same
headers. The actual JSON cap is 32 KiB. Only an unambiguous committed import is
rolled forward: phase `indexing`, current Wiki directory present, staging absent,
constrained sibling paths and a compatible version. Current files are reindexed
and cleanup is finalized. Older backup data is never automatically restored over
newer writes.

Success returns `action: "rolled_forward"`. No journal plus no unrelated active
work returns `action: "no_op"` without reindexing or version increments. Repeated
successful calls are safe no-ops. Malformed/linked/ambiguous journals are retained
for an operator. Failed indexing leaves failed status and the journal for retry;
unrelated pending/processing ingestion cannot be recovered by this operation.

### Errors

| Status | Meaning |
| --- | --- |
| 400 | Invalid IDs, JSON, overwrite flag or native bundle |
| 401 | Invalid/missing credential |
| 404 | Exact service/team/Wiki tuple absent |
| 409 | Active work, unresolved import, conflicting target or locked page |
| 413 | Declared or actual operation body limit exceeded |
| 415 | Expected application/json |
| 500 | Index/finalization fault, ambiguous recovery state or unexpected fault |
| 503 | Service key not configured; new operations disabled |

HTTP errors omit filenames, roots and exception payloads. Index faults are not
coerced to strings. This is not a global upstream log-redaction guarantee.

## Migration and recovery procedure

There is no automatic format conversion or schema migration. Existing Wiki read
behavior remains. The journal guard deliberately refuses legacy mutation while
an import remains unresolved. Do not delete a journal or restore an older tree
just to bypass that guard.

Before importing valuable data, back up metadata and files consistently. After a
failure, stop other writers and preserve the journal, current Wiki, staging and
backup together. Retry recovery only when unambiguous; otherwise use an approved
operator recovery procedure. This endpoint is not full application disaster
recovery and does not manage secret-provider recovery.

## Tests and limitations

```sh
cd MemoryKnowledge
npm test -- tests/okf-bundle-validation.test.ts tests/okf-import-state.test.ts \
  tests/okf-recovery.test.ts tests/okf-path-unicode.test.ts tests/okf-import-api.test.ts
npm run typecheck
npm run build
```

The 83 focused cases use real Linux files, native SQLite, Hono/auth and Wiki index
management without production volumes or a model provider. They cover exact
binary/Unicode bytes, rename rollback, metadata failures, malformed/ambiguous
journals, retry indexing, held mutation guards, locked pages, explicit overwrite,
foreign teams, empty keys, exact 20 MiB JSON/10 MiB decoded/32 KiB selector limits
and misleading Content-Length. The build passes. With prepared dependencies,
whole-project compiler diagnostics remain the same eight as upstream: one Hono
and seven SimpleGit default-import diagnostics using fixture version 4. This is
not a clean whole-upstream typecheck or a fresh install of its SimpleGit 3 range.

Incoming byte/file limits do not bound all YAML/string/metadata memory, existing
tree traversal/copying, indexes, concurrency, deadlines or disk use. Protect
filesystem ancestors and coordinate writers; checks followed by opens/renames do
not defend against an adversary controlling that tree. Service guards apply to
this process, not an OS-wide lock. Low-level directory options are trusted
internal inputs, not request fields. The journal protocol does not fsync every
file/directory and is not a power-loss transaction guarantee. Synthetic fault
tests establish neither full application/secret-provider recovery nor actual
production rollback, independent final review or absence of vulnerabilities.
