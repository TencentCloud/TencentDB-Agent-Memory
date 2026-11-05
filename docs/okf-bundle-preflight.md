# OKF bundle preflight

`MemoryKnowledge/src/engines/wiki/okf-bundle-validation.ts` provides a pure
validation building block for native OKF 0.2 exchange. It does not read or write
files, execute an attester, call a model or fetch a source URI. A stateless HTTP
preflight route exposes this validator through the existing Knowledge router.
The existing `yaml` dependency is sufficient; package versions are unchanged.
The specification baseline is [official OKF 0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/tree/ad30107c31c06aec8a7d5636e0d1058118604e6f).

## API and example

```ts
import { validateBundle, BundleValidationError }
  from "./src/engines/wiki/okf-bundle-validation.js";

const files = [
  { path: "index.md", content: '---\nokf_version: "0.2"\n---\n# Index' },
  { path: "concepts/location.md", content: "---\ntype: Place\nextra: null\n---\nA fact" },
];
try {
  const report = validateBundle(files);
  console.log(report.files, report.concepts, report.warnings);
} catch (error) {
  if (error instanceof BundleValidationError) {
    // Report validation failure before an application schedules any writes.
  } else throw error;
}
```

`BundleFile` contains a relative `path`, string `content`, and optional `encoding`
(`utf-8`, the default, or `base64`). The result counts files and concept pages
and provides path/message warnings. Validation leaves the caller's objects and
content unchanged. Invalid input throws `BundleValidationError`; it does not
return a partially accepted bundle. Callers of the pure function must separately enforce request limits and
authenticated tenant selection before storing any data. The HTTP layer below
provides its own input cap but does not store or select tenant resources.

## Validation and compatibility

A bundle contains 1–1000 files with at most 10 MiB of decoded content in total.
UTF-8 byte lengths and base64 decoded lengths are checked against the remaining
budget before allocating decoded buffers. Base64 validation uses bounded size/
padding checks and a nonrecursive alphabet check, including the exact limit.
Markdown bytes must be valid UTF-8; other attachments may contain opaque bytes.

Paths reject absolute/traversal paths, backslashes, colons, empty/dot segments,
dot-prefixed segments and ASCII control characters. Duplicate names, NFC/case
aliases, directory aliases and file/directory collisions are rejected. These
are transport policies; they do not replace filesystem confinement or establish
portability on every operating system. Previously allowed control-character
filenames require explicit review rather than automatic renaming.

Concept pages require parseable mapping frontmatter with a nonempty string
`type`; custom types and unknown optional metadata remain accepted. Index files
may omit frontmatter at any directory level. Only a root index may contain
frontmatter, limited to `okf_version`; an unknown version produces a warning
for best-effort consumption. Nonstandard log heading shapes also warn.

This module does not derive actor/freshness/trust metadata, resolve links,
migrate records, import/export files, stage filesystem swaps or recover a
failed application. Those are separate consumer and integration concerns.

## Tests and limits

```sh
cd MemoryKnowledge
npm test -- tests/okf-bundle-validation.test.ts
```

Thirty-three focused cases pass on Linux Node 22 with real installed YAML
dependencies, no network access and synthetic inputs. Tests include exact
limits, pre-allocation refusal, UTF-8/base64 validation, opaque attachments,
path aliases/collisions, reserved-file frontmatter and unchanged input. The
tests reuse a prepared dependency installation rather than proving a fresh
install of the upstream graph. This proposal does not fix unrelated inherited
compiler diagnostics or dependency advisories. Fresh upstream `37b1629` and
the proposal have identical full-project diagnostics with the same prepared
dependencies: one Hono body-cache diagnostic and seven default-import
diagnostics caused by that fixture’s SimpleGit 4 installation. The fixture
does not represent a fresh install of upstream’s SimpleGit 3 dependency range.
The application bundle builds and all 38 focused tests pass after adding the
module; no full-project zero-diagnostic claim is made.

The payload cap does not bound already received JSON/string objects, path
metadata, YAML parsing overhead or concurrent validation. Log headings check
shape rather than calendar validity. Case/NFC comparison is a deliberate
collision policy rather than a complete filesystem equivalence model. Optional
metadata is advisory and is not authenticated. Successful preflight is not a
completed independent security review or an authorization decision.


## HTTP preflight and installation

The existing Knowledge service build exposes `POST /v3/wiki/okf/validate`
(or the configured API prefix) without additional packages, services or storage
migrations. Restart the rebuilt service normally. Set `KNOWLEDGE_SERVICE_KEY`
on deployments requiring authentication: the endpoint follows upstream's existing
policy, which permits unauthenticated access when that key is empty. It is not
added to the configured-key read-only allowlist. The header
`x-tdai-service-id` must be a valid service identifier. No team/wiki identifier
is needed because validation accesses only the caller's submitted data.

```sh
export KNOWLEDGE_URL=http://127.0.0.1:8421/v3
# Supply KNOWLEDGE_SERVICE_KEY through your normal secret configuration.
curl --fail-with-body "$KNOWLEDGE_URL/wiki/okf/validate" \
  -H "Authorization: Bearer $KNOWLEDGE_SERVICE_KEY" \
  -H 'x-tdai-service-id: example-service' \
  -H 'Content-Type: application/json' \
  --data '{"files":[{"path":"fact.md","content":"---\ntype: concept\n---\nA fact"}]}'
```

Successful responses use the existing envelope with `code: 0` and
`data: { files, concepts, warnings }`. Warning paths describe supplied input.
The HTTP layer requires JSON media type (415 otherwise), valid UTF-8 JSON
and an object/files shape (400), and caps actual request bytes at 20 MiB (413).
It also refuses an oversized Content-Length declaration before parsing, while
counting streamed bytes even when the header claims a smaller size. Exact
20 MiB valid input and exact 10 MiB decoded base64 payloads are accepted.
Invalid bundles return a static 400 without echoing input filenames; unexpected
stream faults use generic 500. Authentication failure returns the existing 401.
No import, export, indexing, recovery or persistent tenant access is added.

The request cap does not bound all parsing/base64/YAML allocations, warning
metadata, an already allocated oversized incoming chunk or concurrent requests.
Read deadlines, rate limits, deployment key policy and host isolation remain
operator responsibilities. There is no cross-service transaction or full
application recovery claim. Existing unrelated router/auth behavior is unchanged.

Fifty-one targeted Linux Node 22 tests pass with the prepared real dependencies:
38 pure-validator cases and 18 HTTP cases using the actual upstream Wiki router,
service-auth middleware, native SQLite store and filesystem. The stateless case
checks that existing row/file fingerprints and worker/indexing state remain
unchanged. HTTP cases cover configured/empty-key policy, service identities,
malformed roots/JSON/UTF-8/media types, private-path refusal, actual streaming
limits with absent/misleading Content-Length, exact boundaries and stream faults.
No networking or production volumes are used; tests run as a non-root user.
The application bundle builds. Whole-project typing retains the same eight
prepared-fixture diagnostics documented above; no zero-diagnostic upstream claim
or independent final audit is made.

Against the unchanged upstream router, the new successful-preflight API case
returns 404; its two configured-key authentication cases already pass. This
feature adds a reachable operation and does not claim to repair that auth policy.

Paths must contain Unicode scalar values. Lone UTF-16 surrogate halves are rejected because Node filesystem encoding would replace them with U+FFFD and collapse distinct JSON names into one filename. Valid astral characters and the actual replacement character remain accepted. The 56 focused tests include five dedicated Unicode cases; this preflight itself does not write files.

## Unicode text content

UTF-8/default text content rejects unpaired UTF-16 surrogates with HTTP 400.
Node would otherwise silently encode these as U+FFFD, losing the supplied text.
Valid surrogate pairs (astral characters) and an explicit U+FFFD remain accepted.
Use base64 for arbitrary file bytes; Markdown still requires valid UTF-8.

The focused content follow-up was checked with the existing validation and actual
HTTP/auth/SQLite suites in a non-root Linux Node.js 22 container, with network
disabled and synthetic data only. The preflight snapshot passed 64 tests and the
native import snapshot passed 70; this does not replace whole-project dependency,
build, deployment or independent-review acceptance. Both proposals carry the
same pure-validator change and need coordinated integration. Their original
upstream base remains unchanged; a current-upstream rebase is not claimed.
