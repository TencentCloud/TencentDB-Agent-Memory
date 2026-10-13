# TencentDB Agent Memory with native OKF support

A memory system for agents, with conversation storage and retrieval, skills,
Git code graphs, and document wikis. This project retains the upstream source
and adds native Open Knowledge Format (OKF) 0.2 exchange and security fixes.

Upstream base: [TencentCloud/TencentDB-Agent-Memory v2.0.2](https://github.com/TencentCloud/TencentDB-Agent-Memory/commit/274e549069ad780e411d70e6fff51f6a977d81d3).
Specification baseline: [official OKF 0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/tree/ad30107c31c06aec8a7d5636e0d1058118604e6f).
The original project is maintained by TencentCloud; this fork is maintained by adamokon.

## Components and operation

| Component | Purpose | Guide |
| --- | --- | --- |
| MemoryCore | Conversation capture, layered retrieval, skill extraction and gateway APIs | [Core](MemoryCore/README.md) |
| MemoryProxy | Agent-facing LLM forwarding, memory injection and optional extensions | [Proxy](MemoryProxy/README.md) |
| MemoryKnowledge | CodeGraph indexes, generated wikis and native OKF bundles | [Knowledge](MemoryKnowledge/README.md) |
| MemoryPanel | Management backend and web interface | [Panel](MemoryPanel/README.md) |
| SDKs | Client interfaces | [TypeScript SDK](sdk/memory-core/typescript/README.md) |

Native OKF import preserves supplied Markdown and attachment bytes, indexes
concepts for search, and does not invoke an LLM. Generated wiki ingestion is a
separate workflow that requires an LLM configuration. Contracts and optional
metadata are retained; computation runners and attesters are not executed.

Read [data flow and trust](docs/architecture-and-data-flow.md),
[Git transport](docs/git-transport.md), [OKF API and migration](MemoryKnowledge/docs/okf/README.md),
and [verification and limitations](docs/verification-evidence.md).

## Requirements

Use Node.js 22 or later for the standalone Linux service. Development/typechecking
with OpenClaw 2026.10.2 requires Node.js 24.16+ (or its supported Node 26 range).
Native SQLite,
Jieba and CodeGraph packages require compatible platform binaries or their build
toolchains. Linux container verification is a separate requirement; a macOS build
does not establish Linux readiness. Docker Engine and Compose are needed only
for container deployment. A configured LLM is needed for generated ingestion and
conversation extraction, but not native OKF exchange.
The pinned Jieba dependency uses a licensed lazy [loader compatibility adapter](docs/jieba-loader.md)
that preserves native version enforcement; index migration and native trust limits
are documented there.

## Installation from source

Build this checkout. Upstream images do not contain these changes.

```sh
cd MemoryKnowledge
npm ci
npm run build
umask 077
cp .env.example .env
# Configure .env before starting. Keep it out of Git.
npm start
```

The default Knowledge listener is `127.0.0.1:8421`, with API prefix `/v3`.
`npm run dev` starts the TypeScript source; `npm start` uses the built launcher.
For MCP, build first and run `node bin/mcp.mjs` with the configuration below.

For a source-built Knowledge container:

```sh
cd MemoryKnowledge
umask 077
cp docker/env.example docker/env.docker
# Set KNOWLEDGE_SERVICE_KEY and PUBLIC_URL in docker/env.docker.
docker compose --env-file docker/env.docker up -d --build
```

Compose is defined in `MemoryKnowledge/docker-compose.yml`. Its published port
is reachable on host interfaces unless the port mapping or firewall restricts
it. Set the public URL to the actual service base including its API prefix.
This is a source-based deployment recipe; see verification status before using
it as evidence of a tested image.

Other services have separate configuration and data directories:

```sh
# Core: configure the standalone YAML and its LLM/storage settings first.
cd MemoryCore
npm ci
npm run build
export TDAI_GATEWAY_CONFIG="$PWD/tdai-gateway.standalone.yaml"
node --import tsx src/gateway/server.ts

# Proxy: configure the upstream, authentication and memory bindings first.
cd MemoryProxy
npm ci
npm run start:config

# Panel backend and frontend are separate npm projects.
cd MemoryPanel
npm ci
npm run build
npm start
# In MemoryPanel/web: npm ci && npm run build
```

Each `cd` above starts from the repository root. Follow the linked component
guides to configure Core metadata instances, Panel login and Proxy routing; these
commands alone do not configure a complete production system.

## Configuration and authentication

| Setting | Effect |
| --- | --- |
| `KNOWLEDGE_SERVICE_KEY` | Bearer authentication for every Knowledge service API under its prefix |
| `KNOWLEDGE_HOST`, `PORT` | Knowledge listener; defaults `127.0.0.1`, `8421` |
| `API_PREFIX` | HTTP API prefix; defaults `/v3` |
| `KNOWLEDGE_DATA_DIR`, `KNOWLEDGE_DB_PATH` | Knowledge filesystem and metadata SQLite locations; defaults under `./data` |
| `TDAI_GATEWAY_API_KEY` | Core gateway Bearer key; separate from the Knowledge key |
| `KNOWLEDGE_API_URL`, `KNOWLEDGE_SERVICE_ID` | MCP upstream base and one fixed service scope |
| `KNOWLEDGE_API_TOKEN` | MCP Bearer token; falls back to `KNOWLEDGE_SERVICE_KEY` |

Knowledge rejects keyless non-loopback startup unless
`KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN=true` is explicitly set. A configured key
is required even on loopback. `/health`, `/docs` and `/openapi.json` are outside
its service prefix and remain public. Core likewise rejects a keyless
non-loopback bind unless `TDAI_GATEWAY_ALLOW_INSECURE_NO_KEY_LISTEN=true` is set.
Keyless loopback mode is for trusted local development.

A service key authenticates a service, not an end user. A trusted gateway must
resolve identity and enforce user/team permissions before forwarding tenant
headers. Never give an untrusted client unrestricted access to a shared service
key. MCP currently uses one service ID and assumes the default `/v3` prefix.

Core's public state backend supports explicit `STATE_BACKEND=local`. Its session
buffers, timers, task queue and locks live in process memory and are lost on
restart; persistent memory databases are separate. Service mode otherwise selects
Redis by default, whose private state implementation is not shipped here: select
local explicitly only when its lifecycle fits the deployment. Redis and unknown
backend types fail explicitly, with no silent fallback or state migration.
Worker lock identities are encoded per scope. When upgrading from older key
formats, stop old consumers and drain in-flight tasks before starting the new
workers; mixed versions cannot coordinate through different lock names. This
changes coordination keys, not persistent memory records.
New pipeline timers always encode the session and preserve each supplied tenant
field. Scheduling labels accept ASCII letters, digits, `_` and `-`; ordinary
`L1_idle`/`L2_schedule` labels are unchanged. Legacy timer members remain readable,
but stored legacy names are not automatically rewritten or cancelled by new names.
Drain/recreate transient timers when upgrading; legacy scoped metadata must be
trusted, since its ambiguous original identity cannot always be recovered.

Disable optional exporters unless required. Protect environment files, databases,
backups and logs with service-account permissions. Source credentials are
base64-encoded in SQLite, **not encrypted**. The database and its WAL/SHM files
are restricted to mode 0600; use a trusted parent directory and restricted backups.

## API and examples

[Knowledge OpenAPI](MemoryKnowledge/openapi.yaml) describes the HTTP service.
[The OKF guide](MemoryKnowledge/docs/okf/README.md) covers file encoding, statuses,
recovery and migration. The main native endpoints are:

| POST path beneath the API prefix | Request | Result |
| --- | --- | --- |
| `/wiki/okf/validate` | `{files}` | Validation counts and warnings |
| `/wiki/okf/import` | `{team_id,wiki_id,files,overwrite?}` | Save and index supplied files |
| `/wiki/okf/export` | `{team_id,wiki_id}` | Bundle `{files}` |
| `/wiki/okf/recover` | `{team_id,wiki_id}` | Explicit validated recovery or no-op |

All require the configured Bearer key; resource operations also require
`x-tdai-service-id`. Responses use `{code,message,data}`. Validation is 400,
foreign/missing resources are 404, conflicts are 409, body overflow is 413 and
internal failures are 500. Import can report failure after committing content;
retain the journal and recover instead of blindly repeating writes.

Export the checked-in example to a new, private temporary file:

```sh
cd MemoryKnowledge
umask 077
okf_work=$(mktemp -d)
npm run okf -- export examples/okf "$okf_work/bundle.json"
# The output is {files}, not a complete HTTP import body.
```

For an HTTP example that creates an isolated wiki, supplies the required IDs,
keeps the key out of command arguments and round-trips the bundle, see
[the executable example](MemoryKnowledge/examples/okf-http-roundtrip.mjs).
Run it from `MemoryKnowledge` with `KNOWLEDGE_SERVICE_KEY` configured and a
running local service:

```sh
node examples/okf-http-roundtrip.mjs
```

The example uses synthetic content and deletes its created wiki on success.
It does not operate on an existing wiki or use credentials in command arguments.

## Migration, backup and rollback

Before upgrading, stop clients, workers and scheduled sync. Take a consistent
backup of each component's entire data directory, SQLite state (including WAL
when present), configuration and previous image/build. An OKF export excludes
raw inputs, permissions, operational databases and queue state, so it is not a
complete deployment backup.

Use the OKF guide's dry-run legacy Markdown migration before applying changes.
An unknown legacy source-credential schema is retained and startup is refused;
map user-scoped credentials to resources in an explicit offline migration after
backing up the database. Never delete the old table merely to make startup pass.

Keep previous binaries/images and configuration for rollback. If a migration has
changed persistent state, restore the matching consistent backup while all
writers are stopped before restarting the previous version. Test a restore on
an isolated target; archive integrity alone is not a restore test.

## Tests and limitations

Run `npm test` and `npm run typecheck` in Knowledge, Core, Proxy and Panel; run `npm test`
and `npm run build` in Core. In the web project run `npm run build` and `npm run lint`.
Run `npm audit` for each component's lockfile. See the verification document for
actual results, host details, warnings and unexecuted checks.

OKF HTTP transport accepts up to 1,000 files and 10 MiB of decoded data, with a
20 MiB streamed request limit. Unknown concept types and extensions are preserved;
optional trust metadata is advisory. Remote Git uses validated DNS/IP transport,
verified TLS, denied redirects and a 60-second child-process deadline. This is
not a bound on complete native indexing time or memory usage.

CodeGraph rejects symlinks and special filesystem entries, including legitimate
in-tree symlinks, and limits its preflight tree to depth 100 and 100,000 entries.
Tool arguments cannot select another SDK project. These are point-in-time checks
for trusted parent directories and a single writer; they are not an OS sandbox
or a defense against concurrent privileged filesystem changes.

OKF recovery has no startup auto-repair, fsync/power-loss durability or atomic
SQLite/filesystem transaction guarantee. The private Proxy routing/preparation
extension was removed. Other optional private integrations and
native dependencies and optional remote providers require their own operational
and supply-chain assessment. No universal security guarantee is implied.

See [verification evidence and remaining release gates](docs/verification-evidence.md) and [security review findings](docs/security-review.md) for tested scope and limitations.

See the [Knowledge API integration guide](docs/knowledge-api.md) for authentication, native OKF, tool parameters, source credentials and synchronization.

See the [Proxy extension removal and storage migration guide](docs/extension-removal.md) before upgrading an older Proxy configuration.

## License and contribution

[MIT](LICENSE), with upstream copyright and authorship retained. See
[CONTRIBUTING](CONTRIBUTING.md). Report reproducible issues with sanitized test data,
versions and configuration; do not include credentials or private memory.


### Current Core verification and optional host contracts

Strict Core source checking now passes with `npm run typecheck`; 273 Linux tests
and build pass. Install development dependencies on supported Node 24 with
`npm ci --ignore-scripts` to inspect/test host declarations without running native
LLM installation scripts. This does not certify a working native llama backend
or every OpenClaw host integration. The standalone Linux service is also tested
on Node 22. Host packages are development/optional peers, external to that service.

Wiki/CodeGraph schema exports use generated files from
`MemoryKnowledge/openapi.yaml`. Regenerate on Linux with
`cd MemoryCore && npm run generate:knowledge`. The old unpublished Wiki update
request/success/mutation-response validators remain exported but reject all input;
use the documented Knowledge API. Complete legacy error/sync response validators
are retained. This does not add legacy routes to Core. Required team fields are
explicit in the OpenAPI compositions and checked by regression tests.

The Docker image omits development and optional peer packages and removes npm/npx
from its runtime stage. Native llama/OpenClaw integrations require a separately
verified environment or custom image; they are not bundled into this standalone
image. The production and full development dependency audits report no known advisories
in the verified Linux install. A reproducible, locally repackaged development-only
npm archive replaces vulnerable bundled libraries with separately locked patched
versions; its CLI sources and licenses are unchanged. See the [artifact provenance
and maintenance instructions](MemoryCore/vendor/README.md). This does not patch
separate host-managed OpenClaw installations. Independent final review and native
supply-chain/recovery limitations remain open.

The legacy embedded OpenClaw runner requires an injected embedded-agent capability
or the legacy distribution bridge. Current SDK typechecking is not evidence that
modern hosts supply that internal runtime API; absence fails explicitly.

Optional offload HTTP responses are capped at 16 MiB of collected body bytes.
Advertised and streamed over-limit bodies are rejected, truncated responses
settle as failures, and UTF-8 is decoded after collection to preserve codepoints
split across network chunks. This is not a total process-memory or concurrency
limit. See [verification evidence](docs/verification-evidence.md).


Optional offload Opik export requires an explicit enable flag. Shared
`OPIK_API_KEY`/URL environment settings alone do not authorize export. Set
`plugins.entries["opik-openclaw"].enabled` or its `config.enabled` to `true`;
an explicit `false` at either level disables it. Enabling this feature sends
unredacted decision/model/message trace content to the configured Opik collector.
See [the migration and privacy boundaries](docs/security-review.md#offload-opik-explicit-opt-in-13-october-2026).

Offload reclamation skips MMD deletion when active-state metadata is missing,
malformed or symlinked, and skips orphan-ref deletion when surviving reference
indexes cannot be read completely. Pre-existing cleanup directory/file symlinks
are skipped. Repair metadata before retrying cleanup; skipped cleanup can retain
disk usage. Use trusted storage roots and coordinate reclamation with writers.
[Cleanup evidence and limits](docs/security-review.md#offload-reclamation-safety-13-october-2026)
describe the tested boundaries.

Normal offload backend stage diagnostics retain counts and presence flags while
omitting tool names/IDs, task labels, filenames, node mappings and generated skill
names. Request/response data still goes to the selected backend; explicitly
enabled Opik tracing still exports full content. See the
[diagnostic review scope](docs/security-review.md#offload-backend-stage-diagnostics-13-october-2026).

Offload MMD file selectors must be nonempty basenames; ref reads require
`refs/<basename>`. Parent traversal, nested paths, separators and control
characters are rejected with payload-free errors. Generated ref filenames use
the same basename validation. Existing invalid selectors require operator or
producer correction; files are not renamed automatically. This lexical check
requires trusted storage contexts/filesystem ownership and does not prevent
symlink or hard-link traversal. See the
[storage boundary evidence](docs/security-review.md#offload-file-selector-boundaries-13-october-2026).

Offload storage contexts also validate agent and raw session components before
building paths, including real session overrides. JSONL rewrites accept only
`offload-<nonempty-session>.jsonl` basenames and validate all source groups before
starting writes. Invalid selectors leave the previous manager context and
existing files unchanged. These checks do not provide tenant authentication,
atomic multi-file rewrites or filesystem confinement against links/races. See
[context and JSONL selector limits](docs/security-review.md#offload-context-and-jsonl-selectors-13-october-2026).

Offload session registration preserves corrupt or invalid existing registry
metadata by rejecting the write, rather than replacing it with a new map.
Prototype-named keys are stored as ordinary own entries. Lookup accepts only
owned rows with valid basename session IDs, and listing preserves authoritative
map keys. Unavailable lookup/list still returns null/empty results; no automatic
repair or new alerting is provided. See
[registry evidence and recovery limits](docs/security-review.md#offload-registry-integrity-13-october-2026).

Offload state-report upload/scheduling failures emit fixed warnings without
exception payloads or custom string conversion. Native Node regressions cover
privacy and coercion-induced process failures. Successful report export is
unchanged; custom logger failures and malformed success fields still need review.
See [the failure-diagnostic scope](docs/security-review.md#offload-report-failure-diagnostics-13-october-2026).

Offload MMD context refresh compares a SHA-256 fingerprint of the complete decoded
file rather than its length and first 64 characters, so equal-length tail edits
refresh the injected context. Selected injector diagnostics omit filenames and
caught exception payloads; intended prompt context and explicitly enabled tracing
are retained. [Refresh and diagnostic limits](docs/security-review.md#mmd-context-refresh-and-diagnostics-14-october-2026).
