# Knowledge API integration

All paths below are relative to `API_PREFIX` (default `/v3`). Authenticate with
`Authorization: Bearer <KNOWLEDGE_SERVICE_KEY>` and send `x-tdai-service-id`.
Keep service keys in a secret manager or protected process environment, not
command arguments or repository files. Production clients must use verified HTTPS.
Resource routes use a `team_id` in their documented request bodies; source
credential and external Wiki source routes instead require
`x-tdai-team-id` and `x-tdai-user-id` headers as well as the service header.
An authenticated gateway must authorize these identity values for each user.

Responses use `{ "code": 0, "message": "...", "data": ... }` on success.
Check both HTTP status and envelope code: some upstream provider routes report
application errors in a nonzero envelope with HTTP 200. Treat transport errors,
nonzero envelope codes and unexpected response shapes as failures.
The [OpenAPI document](../MemoryKnowledge/openapi.yaml) defines Wiki, CodeGraph
and native OKF request contracts. Source provider and credential operations below
supplement that document; it is not a complete schema for every provider API.

## Native OKF operations

| Method and path | Required JSON fields | Behavior |
| --- | --- | --- |
| `POST /wiki/okf/validate` | `files` | Validate a native bundle without importing it |
| `POST /wiki/okf/import` | `team_id`, `wiki_id`, `files` | Import into an existing Wiki; optional `overwrite` permits replacement |
| `POST /wiki/okf/export` | `team_id`, `wiki_id` | Return a native bundle |
| `POST /wiki/okf/recover` | `team_id`, `wiki_id` | Resolve a persisted interrupted import journal |

Each file is `{ "path": "relative/path", "content": "...", "encoding": "utf8" }`
or a base64 entry with `encoding: "base64"`. HTTP bundles allow at most 1,000
files and 10 MiB of decoded content; streamed requests have a 20 MiB limit.
Paths, duplicate entries and manifests are validated. Foreign/missing resources
return 404. Conflicting files, active processing or unresolved import journals
can return 409. A 500 during import can occur after content was committed;
inspect the resource and journal before retrying.

The native path preserves bundle content and does not invoke an LLM, plugin or
computation runner. Unsupported OKF behavior is reported rather than executed.
See the [OKF guide](../MemoryKnowledge/docs/okf/README.md) for compatibility,
recovery, CLI usage and the supported format. The
[HTTP round-trip example](../MemoryKnowledge/examples/okf-http-roundtrip.mjs)
creates and removes only its own synthetic Wiki and compares exported bytes.

## Read-only agent tools

`POST /tools/list` takes `{ "knowledge_id": "<Wiki-or-CodeGraph-ID>" }` and
returns the supported tools and parameters for that resource.
`POST /tools/call` takes `knowledge_id`, `tool_name` and a `params` object.
Use an ID returned by the create API; do not guess or reuse another tenant's ID.
Tool availability follows the resource state. A successful transport/envelope
can carry a not-ready result; inspect the returned data before assuming execution.

CodeGraph query parameters are allowlisted before index loading and checked again
at the bridge. Callers cannot set `projectPath`, select another graph through
`params.code_graph_id`, or forward undeclared native SDK controls.

| CodeGraph tool | Accepted parameters |
| --- | --- |
| `get_info` | None |
| `search` | Required `query`; optional `kind`, `limit` (1–100, default 10) |
| `explore` | Required `query`; `maxFiles` (1–200, default 12) |
| `callers`, `callees` | Required `symbol`; `limit` (1–200, default 20) |
| `impact` | Required `symbol`; `depth` (1–10, default 2) |
| `node` | Required `symbol`; optional `file`, positive integer `line`, `includeCode` (default false) |
| `status` | None |
| `files` | Optional `path`, `pattern`, `format` (`tree`, `flat`, `grouped`), `includeMetadata`, positive integer `maxDepth` |

Wiki discovery exposes information, search, page reading, graph reading and raw
file reading. Tools return source content to their caller; the caller may forward
that content to an LLM. Do not grant tools to users who must not read the source.
Management operations are separate APIs and are not exposed as query tools.

## Resource-scoped source credentials

Create the target Wiki or CodeGraph first. Credential operations require all three
identity headers described above and check that the resource belongs to the team.
Missing and foreign resources are indistinguishable (404). Resource types are
`wiki` and `code-graph`.

| Method and path | Input |
| --- | --- |
| `GET /source-credential/status` | Query `resource_type`, `resource_id`; returns configuration metadata, never the secret |
| `PUT /source-credential/put` | JSON `resource_type`, `resource_id`, `provider_id`, `secret`; optional `cred_kind` (`bearer` default or `basic`), `username`, `extra` |
| `DELETE /source-credential/delete` | Query `resource_type`, `resource_id` |

Basic credentials require a username. Obtain enabled provider IDs through
`GET /source-provider/code`, `GET /source-provider/wiki` or
`GET /source-provider/`. The provider controls conversion to its required
credential format. The public repository does not contain deployment tokens.
Knowledge stores credentials as reversible base64 in SQLite; restrict state and
backup access. Git authentication is described in the [transport guide](git-transport.md).

## External Wiki sources and synchronization

`POST /wiki-source/list` takes `wiki_id`, `source_url`, `provider_id` and optional
`crawl` (`mode: tree|links`, positive integer `maxDepth`).
`POST /wiki-source/import` takes the same required fields and optional `page_ids`.
These APIs require the three identity headers and use the resource's stored
credential. Provider behavior and outbound destinations are provider-specific;
review source permissions and credential scopes before enabling one.

`GET /auto-sync/status` returns scheduler state. `POST /auto-sync/trigger` starts
an explicit synchronization when the scheduler is enabled. Auto-sync is disabled
by default; an explicit trigger does not activate a disabled scheduler.
Schedule configuration and defaults are documented in the
[Knowledge README](../MemoryKnowledge/README.md#auto-sync).

`POST /internal/llm-binding/set`, `/status` and `/list` manage or inspect per-service
LLM bindings. These are trusted operator APIs protected by the Knowledge service
key. They are not user authorization endpoints and should not be exposed through
a gateway that permits untrusted service IDs.

## Migration and retries

Back up state while writers are stopped before changing versions. Keep the old
binaries/images with the corresponding database and Wiki state for rollback.
Unknown legacy credential schemas fail startup without deleting their records;
perform an explicit offline migration rather than treating credentials as expendable.
An OKF journal must be recovered before subsequent Wiki mutations. Do not retry
imports blindly after an ambiguous failure. See the root README and OKF guide for
backup scope, recovery behavior and the single-writer/trusted-directory assumptions.

## Core Knowledge metadata creation

The separate Core gateway exposes `/v3/knowledge/create` for metadata registered
with a memory backend; it is distinct from this service's Wiki content endpoints
and uses Core gateway authentication. Its optional `summary` and `user_id` fields
are normalized to `null` when omitted before backend creation. A nonempty
`user_id` is preserved; explicitly sending an empty string remains invalid.
`summary` accepts a string or `null`. This normalization needs no data migration
and does not change management-plane credential privileges or team authorization.
