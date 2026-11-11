# Bounded filesystem bundle export

`MemoryKnowledge/src/engines/wiki/okf-bundle-export.ts` adds an independently
usable filesystem exporter for native OKF exchange. It preserves visible file
bytes and relative paths in base64 transport entries. The module uses only Node
built-ins, requires no new dependency and does not fetch URLs, invoke models,
execute file contents, create routes or change stored data.

## API

```ts
import { exportBundle, BundleExportError }
  from "./src/engines/wiki/okf-bundle-export.js";

try {
  const files = exportBundle("/path/to/an/owned/immutable-wiki-snapshot");
  // Apply independent format preflight and transport/authorization policies.
} catch (error) {
  if (error instanceof BundleExportError) console.log(error.kind);
  else throw error;
}
```

The result contains `{ path, content, encoding: "base64" }` entries sorted by
relative path. An empty directory produces `[]`; empty regular files are allowed.
`BundleExportError.kind` distinguishes `budget`, `filesystem` and `path` failures.
Filesystem failures use generic messages rather than disclosing configured
absolute roots. Callers should retain their own appropriately scoped diagnostics.

## File and byte limits

Export permits at most 1000 regular files and 10 MiB of decoded content in total.
The next file is opened with `O_NOFOLLOW | O_NONBLOCK`, checked with `fstat`, and
refused before content reads if its size exceeds the remaining budget. Regular
files are read in chunks of at most 64 KiB. A single sentinel byte detects
over-budget growth after `fstat`; at most the remaining budget plus one byte is
read for that file. Descriptors are closed after success or refusal. The 1001st
file is refused before opening it.

Pre-existing visible symlinks, nonregular entries and symlinked roots/directories
are rejected. Hidden names are skipped without exporting private application
state; this is not a classifier for sensitive data in visible files. ASCII
control characters, backslashes and colons in visible filenames are refused
rather than renamed. Directory traversal is iterative, not recursively dependent
on the JavaScript call stack. Platforms lacking the checked-open flags cannot
export regular files through this helper. Linux is the verified target.

## Installation, migration and tests

This module fits the existing Knowledge source build without package changes.
The pure function remains a building block. The authenticated service route
described below exports existing Wiki files without rewriting them. Applications
may compose its structural file entries with a separately reviewed bundle
preflight validator. YAML schema, reserved-file rules, normalized aliases,
actor/freshness semantics, transport, authentication and durable recovery are
separate concerns. No data migration or automatic rewriting is performed.

```sh
cd MemoryKnowledge
npm test -- tests/okf-bundle-export.test.ts
```

Fifteen synthetic Linux Node 22 cases cover nested UTF-8/binary byte equality,
empty files/directories, exact limits, sparse oversized files rejected before
content reads, remaining aggregate budgets, real file growth during export,
file-count refusal, filename policy, symlinks, FIFO refusal, a leaf-link swap,
a FIFO replacement in a bounded subprocess, and sanitized errors. Filesystem
reads and file mutations are real; selected
Node function interception makes growth/open races deterministic. Tests run as
a non-root user without networking or production volumes.

## Real limits

Use a trusted root and protected ancestors, coordinate writers, and prefer an
immutable snapshot for consistent exports. Leaf `O_NOFOLLOW` is not protection
against ancestor-directory replacement or all filesystem races. Same-size edits
and truncation can yield a changed or mixed view; this helper does not provide a
cross-file transaction or an authenticated tenant boundary.

The payload budget does not bound all base64/JSON overhead, directory-entry
arrays, traversal metadata or concurrent requests. It does not guarantee
absence of vulnerabilities or establish native dependency trust. Complete
application/secret-provider recovery and independent final review remain
separate from these file-read tests.

The application bundle builds with this module added on upstream `37b1629`.
Whole-project compiler output is identical before/after with the prepared
dependency fixture: eight diagnostics, comprising one Hono body-cache diagnostic
and seven SimpleGit default-import call diagnostics under fixture version 4.
That fixture is not a fresh install of upstream’s SimpleGit 3 dependency range.
No whole-project zero-diagnostic or advisory-remediation claim is made.


## Authenticated Wiki export API

The existing Knowledge build adds `POST /v3/wiki/okf/export` (or the configured
API prefix), with OpenAPI documentation. No dependency, data migration, model,
indexing job or recovery/import implementation is added. Rebuild and restart
with a nonempty `KNOWLEDGE_SERVICE_KEY`. This full-file operation is disabled
with 503 when no key is configured, independently of upstream's legacy open
read-only policy. Embedded users of `createWikiRoutes` must supply the optional
`serviceAuth` configuration; omission disables this new operation. Existing
routes retain their authentication behavior.

```sh
export KNOWLEDGE_URL=http://127.0.0.1:8421/v3
# Supply KNOWLEDGE_SERVICE_KEY through your normal secret configuration.
# Replace the example identities with an existing Wiki's exact tuple.
curl --fail-with-body "$KNOWLEDGE_URL/wiki/okf/export" \
  -H "Authorization: Bearer $KNOWLEDGE_SERVICE_KEY" \
  -H 'x-tdai-service-id: example-service' \
  -H 'Content-Type: application/json' \
  --data '{"team_id":"example-team","wiki_id":"wiki-example"}'
```

The response uses `code: 0, data: { files }`; entries preserve original bytes
with `encoding: "base64"` and are sorted by relative path. The exact
service/team/Wiki tuple is resolved in SQLite before reading files. Missing or
foreign tuples return 404; pending/processing state returns 409. The configured
shared key is a service-admin credential: it does not cryptographically bind
a caller to a tenant. Do not distribute it to mutually untrusted users; their
identity authorization requires a trusted upstream gateway or separate controls.

Requests require a valid service header and JSON object with safe `team_id` and
`wiki_id` identifiers. The route checks its credential even without an outer
auth middleware. Missing/wrong credentials return 401, malformed selectors or
JSON 400, oversized declared/actual request bytes 413 and wrong media type 415.
It counts actual streamed bytes up to 32 KiB even with a misleading smaller
Content-Length. File/path/decoded-payload budgets return 400, unsafe or
unavailable filesystem state 409, unexpected stream/store failures generic 500.
Errors omit configured roots, filenames and raw exceptions. The full export
response can be much larger than the selector request.

This is an export transport, not a converter or a schema validator. Existing
visible files may contain private information and non-OKF documents; hidden-name
filtering is not a sensitive-data classifier. Apply separate format preflight
and explicit disclosure policy as needed. Coordinate writers and protect all
ancestor directories: leaf no-follow checks do not provide a cross-file snapshot,
complete filesystem confinement or a transaction with the tenant-row lookup.

Thirty-five focused Linux Node 22 cases pass with the prepared real dependency
fixture: 15 filesystem-helper tests and 20 actual Wiki-router/auth/native-SQLite/
filesystem HTTP tests. Cases cover exact binary/Unicode bytes, hidden-name
filtering, unchanged rows/files and no worker/indexing, configured/empty-key and
standalone route enforcement, foreign tuples, unsafe selectors, processing states,
real sparse oversized files, filename/root/leaf symlinks, 32 KiB streamed request
boundaries, exact 10 MiB content and contained stream/backend faults. Tests run
as a non-root user without networking or production volumes.

The unchanged upstream router returns 404 for this new export operation;
configured outer authentication already rejects missing credentials. This
proposal adds complete-file export and its explicit local authentication guard,
not a claim that an absent upstream endpoint previously leaked data. The
application bundle builds. Whole-project diagnostic lines are identical
before/after: the eight prepared-fixture diagnostics described above.
