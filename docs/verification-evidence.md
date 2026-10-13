# Verification evidence and release gates

The candidate preserves upstream v2.0.2 and its three subsequent commits through
`b1f79fc4714b1e20a1ab94ec6b98e50100af6dc4`. The OKF specification revision is
`ad30107c31c06aec8a7d5636e0d1058118604e6f`. Results below were obtained on
the original macOS Node.js 22.22.3 environment and Linux containers with
Node.js 22.23.3 and 24.21.0 from 11–13 October 2026. The current Core dependency
remediation and compatibility checks run on Linux. They are bounded engineering
checks, not a guarantee that all vulnerabilities or malicious behavior are absent.

| Component | Verification |
| --- | --- |
| Knowledge | 283 tests passed on macOS and Linux; fresh `npm ci`, typecheck and pretest build passed |
| Core | 201 tests, strict full-source typecheck and build passed on Linux Node 22; official OpenClaw declarations are checked with development dependencies; runtime host/native-llama interoperability remains bounded |
| Proxy | 31 tests passed on macOS and Linux; typecheck passed, including Core service-key forwarding; tests use an in-memory database |
| Panel backend | 41 tests passed; typecheck and build passed |
| Panel web | Build and lint passed with 32 remaining warnings; bundle size warning remains |
| TypeScript SDK | Build and 36 real HTTP/HTTPS tests passed for v2/v3, STS and COS transports |
| Hermes/Opik stdlib clients | 8 real HTTP redirect/privacy regression tests passed; five redirect statuses covered for both methods/clients |
| Python SDK | 69 real HTTPS tests passed, covering sync/async clients, TLS trust, hostname rejection, transport log privacy, redirect rejection with injected clients and STS/COS retry behavior |
| OKF example | Actual temporary Knowledge service: create, validate, import, export byte comparison and deletion passed |
| Dependency advisories | Core production and full development graphs: zero known advisories after a fresh Linux installation with the verified unbundled npm artifact; other components retain their recorded bounded scan results |

The transport fixtures use temporary HTTPS Git servers, synthetic credentials,
local certificate authorities and exact repository content checks. Native index
handles are mocked in worker and routing boundary tests: these tests do not prove
that the compiled indexing engine itself is safe against every hostile input.
The Python suite uses httpx 0.28.1 and temporary self-signed certificates.

## Linux and existing-installation validation

All three production images (Core, combined Panel/Knowledge, and Proxy) built
successfully on Linux using the committed lockfiles. Linux Knowledge and Proxy
typechecks passed. Test containers used synthetic data and no production volumes.
Build networking required the build host network in the tested environment;
runtime network protections were preserved.

An existing installation was upgraded after a full stopped-container backup,
archive-integrity verification, and a consistent snapshot immediately before
cutover. Existing document bytes and memory read results were compared with the
baseline. The three services became healthy. Missing or invalid service/client
credentials were rejected, foreign-tenant adapter access was rejected, and
spoofed tenant headers were ignored. The actual deployed Knowledge service passed
native OKF create/import/export byte comparison/delete. A synthetic adapter
credential and wiki were removed after validation; original client configuration
was restored. Prior images and launchers were retained for rollback.

The stopped-container archive was restored into a separate LXC with no network
interfaces. The restored OS booted and the Docker image/volume store was present;
application daemons were masked before boot and the rehearsal LXC was removed.
Ten separately restored SQLite copies also passed integrity checks. Full application
recovery, including access to its secret provider, was not tested. A separate
independent final security audit has not been completed for this candidate.
Neither test results nor deployment success certify the absence of all flaws.

The private routing/preparation extension and Proxy COS factory have been removed;
see the [migration guide](extension-removal.md).
Compiled third-party artifacts also require separate supply-chain validation.
Credentials are stored as reversible base64 in Knowledge SQLite, not encrypted.
Git authentication headers are isolated from argv and persisted Git config but
remain visible in the child environment to sufficiently privileged local processes.

Before publication, review the complete final tree and reachable Git history for
secrets, private deployment data and unintended files. Preserve upstream history
and authorship and package the final contribution as a single commit. Such a
history check does not establish removal of copies retained by hosting systems.

See the [security review scope and findings](security-review.md) for automated
scan coverage, reproduced redirect leakage, corrected behavior and optional
plugin typecheck limits. GitHub Actions also performs a fresh Knowledge locked
installation/typecheck/test/build and the stdlib, Python SDK and TypeScript/Panel transport regression suites.

Linux native SQLite: verified locked source compiled with networking denied against production Node 22.23.3; default addon load passed read/write/transaction/rollback/FTS/integrity and actual isolated Knowledge server OKF/auth/tenant probes. Knowledge Docker/Ubuntu CI now build native SQLite from source; broader native provenance remains unresolved.

OTLP gRPC configuration: an actual Linux loopback collector reproduced ignored
explicit authentication; the corrected initializer sends configured authorization
and tenant metadata on both trace and log exports. Core has 43 passing Linux
tests/build; a fresh Linux strict probe reports 193 diagnostics and fails. No
production collector was contacted by this synthetic regression.

Telemetry initialization privacy: two actual Linux initializer tests reproduced
collector URL/private identifier logging and invalid metadata-key diagnostics.
The application messages now omit those values and raw initialization exceptions,
while preserving success/failure behavior. Core45 tests/build passed; no telemetry
was emitted to an external collector. This is not whole-SDK log redaction.

Knowledge nullable-field contract: four handler/backend-construction regressions
(two failures before the correction) verify omitted fields become `null`, explicit
values survive, and empty user identifiers cause no write. The actual Mongo
backend method runs with a mocked collection transport, without a live Mongo
server. Core49 tests/build passed on isolated Linux; strict Core typecheck still
fails with 189 diagnostics.

## Quota manager log privacy and Core type contracts

Three actual quota-manager regressions reproduced logging of instance identifiers
and reporter error payloads. Application messages now omit those details and usage
counters while preserving reporter arguments, cached accounting, default fallback,
limit decisions and containment of reporting failures. These synthetic reporter
tests do not validate a live quota service or alter quota/authentication policy.

The quota logger type import now points to the shared Core interface; vector-data
availability is an explicit boolean; OTel resource construction uses the typed
factory provided by the declared resources 2.x dependency. No ambient stubs or
type-error suppression were introduced. All 52 Core tests and build passed on
Linux with external networking disabled; fresh strict typecheck still fails with
189 diagnostics, three fewer after these contract corrections. This bounds log
privacy to the reviewed quota-manager messages, not all telemetry/exporter logs.

## Standalone filesystem tool boundary

The standalone runner now uses path-component boundaries instead of a string
prefix and rejects symlinks below the operator-selected workspace root. Read,
write and edit can no longer select a similarly named sibling directory or
follow an existing file/directory symlink outside the workspace. New nested files
remain supported; writes recheck the path after creating parent directories.
Nine synthetic Linux regressions failed before the fix and pass afterward; an
in-workspace write/read/edit regression also passes. The model transport is
mocked, while the actual runner tool functions operate on temporary Linux files.
All 62 Core tests and build passed without external networking.

These checks require a trusted workspace owner and mount. They do not eliminate
concurrent filesystem replacement races, hard-link aliases or malicious mounts.
Use an isolated Linux filesystem/container for tools processing untrusted inputs;
do not grant another process write access to the workspace or its parents.
Caller-supplied and storage-backed tools have separate access policies.

## Standalone runner and storage-tool log privacy

Four Linux regressions reproduced private task/model/tool identifiers, tool-call
arguments, filesystem/storage paths and backend error payloads in application
logs. Runner and tool messages now contain operation names, counts and timing
instead. Failed-call error reporting uses a fixed summary; the original exception
is still rethrown to the caller. File/storage results and normal execution remain
unchanged. Tests exercise actual tool functions and the local storage adapter on
temporary files; model generation is mocked and backend failures are injected.
All 66 Core tests and build passed on isolated Linux without external networking.

This is a bounded correction to these application messages. Configured AI SDK
telemetry/exporters may still collect inputs and tenant metadata; caller handling
of rethrown exceptions and other host logs need separate review. Tool responses
returned to the model intentionally retain file contents and operational errors.

## Standalone AI SDK contracts

The runner and skill-extraction interfaces now use the installed SDK's ToolSet
contract, and telemetry metadata uses its TelemetrySettings attribute contract.
The unsupported provider compatibility option is removed; provider.chat(model)
still selects Chat Completions explicitly. No type-error suppressions or fake
host declarations were added. Fresh Linux strict checking reports 186 diagnostics
(down from 189), with none in the standalone runner; whole-Core checking fails.

Three actual SDK tests use a synthetic loopback HTTP server with external
networking disabled. They verify plain text, streaming and a two-request tool
loop, including the Chat Completions endpoint, authorization header, caller tool
execution/result forwarding, tool omission when disabled and cumulative token
usage. All 69 Core tests and build passed on Linux. This verifies the installed
SDK contract, not interoperability with every real provider or host.

These SDK contracts are included in the verified Linux Core derivative together
with the optional-backend correction below. Seven runtime source hashes matched
the candidate and active container. A consistent snapshot and guarded code-only
rollback preceded cutover; three services and the adapter were healthy, existing
memory hashes and 40 documents were unchanged, and six native OKF fixture files
round-tripped byte-identically with cleanup. This is a source-only derivative,
not a fresh full-image rebuild or full disaster-recovery rehearsal.

## Retired backend selection and safe initialization

The absent private internal observability integration previously fell back to
console output, exposing attributes/errors without explicit console selection.
Internal selection now throws a clear unsupported-backend error; the process
initializer contains that failure with noop and omits raw error payloads.
Gateway status reports the actual selected backend. Explicit console debugging,
OTLP and default noop remain available through the public factory. The gateway's
legacy internal facade becomes noop in this build; separately configured SDK
exporters remain distinct and are not certified private by this correction.

The unshipped Core COS factory integration is rejected explicitly, without a
dynamic import or credential-provider access. This does not remove the SDK COS
transports or existing storage-adapter interfaces. Use local storage in this
public factory; migrate actual data separately before changing storage settings.

Five Linux factory tests cover rejection, noop containment without attribute
leakage, initializer error privacy and explicit console/default behavior. Four
assertions failed before the correction; COS already rejected missing credentials
beforehand, so its clearer unsupported error is not a newly fixed data-access
vulnerability. Core74 tests/build pass; strict checking still fails with 183
diagnostics, three fewer after removal of unavailable integration imports.


## Upstream integration and HTTP failure privacy

The contribution was reapplied to a clean checkout of upstream
`b1f79fc4714b1e20a1ab94ec6b98e50100af6dc4`, preserving all three new commits
and their authorship. The FTS5 health field and graceful offload degradation
remain present. The missing health response type was completed; three synthetic
handler tests cover FTS5 available, unavailable and absent vector storage. These
handler tests do not establish real OpenClaw host integration.

The upstream LLM failure diagnostic included the provider URL, message and
response body. An actual SDK request to a synthetic loopback HTTP 400 server
reproduced disclosure with that logging block (one privacy assertion failed).
The corrected runner retains only a validated numeric HTTP status and timing;
the original exception still reaches its caller. The same regression passed
with the correction, along with 78 Linux Core tests and build. No external AI
provider was contacted. Full strict Core checking still fails with 183
diagnostics. Other callers and configured exporters require separate review.


## Local state boundary and factory regressions

Six real LocalStateBackend tests failed before correction and passed afterward:
colon-containing team/agent tuples, omitted/empty/underscore identities, exact
instance session listing, exact instance purge across states/buffers/timers,
colliding timer removal and expiration/rescheduling isolation. These operate on
the real in-memory backend with synthetic identities, not a remote Redis service
or authenticated gateway. Five of six public state-factory assertions failed
before correction; all pass afterward, including normal local buffering.
Linux Core90/build pass, fresh strict checking reports181 diagnostics and fails.
No type suppressions or private integration stubs were introduced. This evidence
does not establish caller-level authorization, durable queue recovery, timer-member
parsing safety or isolation of arbitrary caller-created lock keys.


## Worker lock coordination

Nine synthetic Linux tests cover colon-containing L1/L2 identity scopes with
actual LocalStateBackend lock acquisition, missing versus underscore identity,
offload instance/MMD delimiter collisions, session/agent exclusion policy,
instance mode and lock-free stages, legacy data/profile resolution, brace syntax
and rejection of non-string offload targets. Six failed with the previous worker
method; all pass with the correction. Core99 tests/build pass; fresh strict Core
checking still fails with181 diagnostics. Tests call the actual scope method
using a synthetic receiver; they do not run a live Redis service, full scheduler,
LLM or external provider. Mixed-version coordination is not supported: stop old
consumers and drain in-flight work before installing the new lock-key format.


## Pipeline timer serialization

Eleven Linux cases cover partial team/agent round trips and non-collision, empty
versus omitted context, legacy-looking literal sessions, punctuation/Unicode,
ordinary timer classification, old unscoped/scoped/profile decoding and inferred
profiles, actual local timer retention, and four invalid new scheduling labels.
Nine assertions fail with the previous helper; all pass after correction.
Core110/build pass; fresh full strict checking still fails with181 diagnostics.
These tests use synthetic data and the actual in-memory timer store, without a
live Redis service, remote scanner, full gateway scheduling or external provider.
Legacy members remain readable but are not automatically rewritten or cancelled;
old ambiguous metadata cannot be reliably repaired without trusted context.


## Skill wiring source contracts

Five Linux regressions exercise actual core/resolver behavior through synthetic
receivers and a real in-memory SQLite database/local storage adapter. Four failed
before correction and all pass afterward: disabling while readiness is pending,
injected COS capability, obsolete config non-access, raw failure diagnostic
privacy and ordinary local initialization without an LLM. Core115/build pass;
fresh full strict Core checking still fails with163 diagnostics, 18 fewer after
correcting missing config/logger and nullable resolver contracts. This is not a
live COS connection/authorization test or complete skill lifecycle verification;
no external AI provider was called. Remaining generated contract errors and
independent final review are still outstanding.

## SQLite skill scope containment

SQLite Skill Store now distinguishes omitted identity filters from explicitly
empty strings for head/version reads, counts, listing, FTS search, archival and
deletion. Omitted filters retain the existing privileged management semantics;
callers remain responsible for authorization. FTS hits are rechecked against the
authoritative skill row for every supplied team, agent, task and user filter.
This prevents stale secondary-index identities from broadening result scope.

Thirteen regressions use actual Node native in-memory SQLite and FTS5 without
network or an LLM: twelve failed before correction; all pass afterward, including
ordinary management lifecycle and foreign-row/index preservation after rejected
archive/delete. This is storage-layer containment, not proof of an exploitable
HTTP authorization bypass or complete tenant isolation. Core128/build pass on
Linux; full strict Core checking still fails with163 diagnostics. The source-only
candidate is checked separately before production cutover.

## SQLite skill row contracts

Full skill-row reads now validate persisted text fields, positive safe-integer
versions, boolean head flags, supported active/archived status and safe-integer
timestamps. SQL bindings use the actual Node SQLInputValue type; aggregate and
deletion counts are checked and returned as safe numbers. Invalid rows fail with
a fixed diagnostic containing no persisted values. No data is rewritten or
removed by validation. Back up and inspect malformed rows before operator repair;
validation does not automatically migrate corrupt records. Existing malformed
manifest JSON still falls back to an empty list without modifying storage; this
change does not provide complete manifest-entry validation.

Six actual native in-memory SQLite regressions cover invalid persisted values
and valid versioning/count/deletion/legacy fallback. Four fail before correction;
all pass afterward. Linux Core134/build pass; strict Core still fails with154
diagnostics (163 before, nine row/binding/count errors resolved without type
suppression). Other stores, projected maintenance/FTS rows, full application
lifecycle and independent complete final review remain outside this evidence.

## Embedding view bounds and replacement containment

SQLite skill writes, deferred L0 embedding updates and L0/L1 reindexing now bind
only the supplied Float32Array byte range, including its offset. A view no longer
passes unrelated values from its backing buffer. Skill vector replacement uses
a synchronous savepoint around deletion/insertion; insertion failure rolls back
that replacement while retaining a caller-owned transaction. Selected skill
embedding insert/delete diagnostics omit raw backend errors. Connection failure
can also prevent rollback; these checks do not guarantee recovery from storage
failure. Other VectorStore logs and reindex attempt-count semantics are unchanged.

Eight Linux regressions: seven fail before correction/all pass afterward. Two
load the locked Linux sqlite-vec extension and exercise actual skill writes;
SQLite triggers inject insertion/deletion failures into a regular synthetic
vector table for atomicity/log tests. Deferred L0 and L0/L1 reindex tests call
actual methods with prepared native SQLite statements on synthetic receivers;
this is not complete VectorStore lifecycle or exhaustive vec0 failure testing.
No production reindex or external embedding service is used. Existing vectors
are not automatically rebuilt: schedule verified reindexing separately where
prior view writes failed. Native library provenance remains an open audit item.

Core142/build pass; strict Core153 still fails. One obsolete L1 call argument
error was corrected by passing its actual sessionKey-only contract; the removed
empty message fields were ignored by the runner, which reads its stored backlog.

## Local storage backend boundaries

The local object backend checks existing path components below its trusted
configured root with lstat, rejecting symbolic links for object reads, writes,
appends, existence checks, deletion and directory removal. Metadata sidecars are
checked separately; writes recheck after creating parent directories. Listings
skip symbolic links and check directories before traversal. Object keys resolving
to the root itself are rejected, including destructive "." requests; root listing
with an empty prefix remains supported. Guard diagnostics omit invalid key values.
Other filesystem errors and debug logs are not globally redacted.

Thirteen actual Linux filesystem regressions: twelve fail before correction/all
pass afterward; ordinary nested append/metadata/list/delete semantics remain.
This covers pre-existing symlinks and root-key errors, not race-free filesystem
confinement, hardlink aliases, malicious mounts or full tenant authorization.
The configured root and its ancestors are trusted; keep them owned by trusted
administrators and use OS isolation against untrusted concurrent writers.
Migrate intentional symlink-backed objects to ordinary files before using this
backend; never repair existing storage automatically. The skill cleanup and
other local-storage consumers receive the backend guard without changing their
higher-level authorization or deletion policies. Core155/build pass on Linux;
strict Core still fails with153 diagnostics. Projected SQL rows, manifest entries,
other backends and complete application recovery remain open review items.

## Scoped storage adapter contracts

Scope construction now rejects absolute, dot/traversal, backslash and NUL
prefixes instead of silently widening or reinterpreting them. Repeated relative
slashes still normalize; an explicitly empty string preserves the existing
unscoped management adapter. Callers must authorize that view. Scoped request
key diagnostics omit key values. Backend object keys, list entries and pagination
markers must remain inside the canonical scope; foreign or noncanonical keys
fail with a fixed diagnostic rather than being returned to the scoped caller.

Twelve Linux regressions: ten fail before correction/all pass afterward. Actual
local filesystem adapters cover construction and ordinary scoped read/write/
append/list/delete; injected backend replies reproduce foreign object, entry,
marker and dot-segment keys. This proves adapter contract containment, not an
HTTP authorization exploit, complete end-user/tenant authorization, correctness
of aggregate counts or contents from a malicious backend, or every remote/rowfs
transport. Existing normal prefixes and explicitly empty management views remain;
use canonical relative scope prefixes when migrating callers. Core167/build pass;
full strict Core remains failing with153 diagnostics. No new auth principal,
backend fallback, automatic scope migration or data repair is introduced.

## Conversation search response and diagnostic contracts

The SQLite FTS response now preserves session_id, user_id and agent_id from its
store result, matching the declared response and native/vector paths. Search
entry/FTS/session-filter diagnostics omit query text, tokens and session values;
selected FTS/vector failure warnings omit raw backend messages. Search requests,
returned content and identity, ranking/filter/limit behavior remain available.
Counts/scores and caller/store/exporter diagnostics are not globally redacted.

Five Linux tests: three fail before correction/all pass afterward. A real
in-memory native SQLite VectorStore is initialized; search rows/backend failures
are injected to exercise actual response mapping, filtering and diagnostics.
Native-text and empty-query behavior remain. This is not end-user authorization,
full SQL ranking, remote backend or external embedding-provider evidence.
Filesystem persona backup manager construction now occurs only with a valid
filesystem path; adapter-backed persona backup remains unsupported. That small
construction correction was verified by source review and source compilation,
not a complete persona generation/restore rehearsal. Core172/build pass; strict
Core151 still fails (153 before, two actual response/construction errors removed
without suppression). Independent complete final review remains outstanding.

## Filesystem backup snapshot contracts

Filesystem BackupManager refuses existing file/directory snapshot names instead
of overwriting or merging generations. New backup directories use mode 0700;
existing directory permissions are not automatically changed. Category/tag labels
must be nonempty ASCII letters/digits/underscore/hyphen filename components.
Directory snapshots carry a reserved .backup-incomplete marker during copying;
failed new copies are cleaned up best-effort, and marked/empty/unmanaged directory
entries are excluded from selection/retention. Retention only targets owned names
of the expected type, preserving unrelated operator files. Legacy unmarked,
nonempty snapshots remain eligible; validate them manually before restoration.

A repeated timestamp/tag produces EEXIST: retry after the clock advances or use
a distinct valid tag, keeping the original backup. The marker name is reserved;
source directories containing it are rejected before copying. Permission/cleanup
failures may leave debris. This is not crash-durable or multi-writer atomic
snapshotting, checksum verification of file copies, or compare-and-swap protection
against restoring over newer writes. The existing directory restore is destructive
and requires an authorized caller with a verified recovery plan; no production
restore was run. Directory snapshots remain shallow regular-file copies.

Ten actual Linux filesystem regressions: nine fail before correction/all pass
now. Coverage includes collisions, real first-copy plus injected later-copy and
cleanup failures, marked snapshot exclusion, label guards, 0700 creation, retention
and complete restoration into a separate synthetic destination. Core182/build
pass; strict Core151 still fails. This does not implement adapter-backed persona/
scene snapshots or prove full application/secret-provider recovery. The filesystem
helper follow-up is staged for the next verified Core release; the installed
adapter-backed service remains on the prior conversation-search derivative.

## Scene extraction failure recovery

Two Linux tests run the actual SceneExtractor with an injected failing runner and
real temporary files. Both fail before correction: an empty scene directory
resurrects a historical snapshot, and a write made after backup is reverted.
Both pass after removing the automatic restore. Failure status/original returned
error and pre-run backup availability are retained. No external provider or
production data is used. Partial writes now remain for explicit recovery review;
this is not transactional extraction, adapter-backed backup or complete disaster
recovery. Core184 tests/build pass; full strict Core151 still fails.


## Generation failure log privacy

Selected scene extraction and persona generation runner-failure diagnostics omit
raw exception messages, stacks and thrown strings. Four tests run the actual
generators with an injected failing runner and real Linux temporary directories:
all fail before correction and pass afterward. Failure status is preserved, and
the original scene error remains in the caller result. No external AI is invoked.
Core188 tests/build pass; full strict Core151 still fails. This is a bounded
application-log fix: other diagnostics, caller results and configured exporter
paths are not globally redacted or certified safe. No production data is used.


## Optional observability attributes

The obsLogger facade accepts optional scalar attributes and omits undefined
values before both backend export and local file writing. Backend interfaces
still require defined scalar values. Present empty strings, false and zero are
preserved; caller input is not mutated. Three actual-facade Linux regressions
fail before and pass after correction, capturing backend arguments and reading
real temporary log files. The backend is injected, not a live collector.

Core191 tests/build pass. Full strict checking still fails with 120 diagnostics,
down from 151 after correcting 31 optional-input mismatches without suppressions
or fake declarations. This change does not redact supplied identifiers, arbitrary
attributes or event names. Direct backend and configured exporter privacy
still require review; the facade Error argument is handled separately below. No production data is used.


## Observability facade exception privacy

obsLogger.error records a fixed error.present flag instead of deriving message
or name attributes, and does not forward the Error object to the backend. It
does not inspect exception getters. Callers retain their original Error and
attributes; the event and defined scalar attributes remain available.

Two actual-facade Linux tests fail before and pass after correction: private
message/name/stack/cause payloads are absent from captured backend arguments and
real temporary log files, and a throwing message getter is not invoked or allowed
to drop the event. Three optional-attribute regressions still pass. The backend
is injected; no live collector or production data is used. Core193 tests/build
pass; full strict Core120 still fails. Explicit caller-supplied attributes/event
names and direct backend/exporter calls are not globally redacted by this fix.


## Complete Core source typecheck and Linux deployment preparation

`npm run typecheck` now runs the existing strict/no-emit full index/src check and
passes: 120 diagnostics were corrected without excluding source files, disabling
strictness, adding fake host declarations or suppression directives. Real pinned
OpenClaw 2026.10.2 and node-llama-cpp 3.22.1 declarations are development peers;
current OpenClaw development requires a supported Node 24/26 toolchain. The Linux
standalone service remains Node 22. The embedded host bridge is a checked legacy
capability; current declarations do not prove that the host supplies that internal
entrypoint. It fails explicitly when neither injection nor the legacy bridge exists.

Corrections cover CLI registration against the actual host Command contract,
legacy runner capability detection, optional config identity without widening
service tenant scope, gateway logger/state assembly, unavailable private gateway
adapters failing explicitly, compression placeholders, metadata pagination,
Zod 4 record validation, sync/async entity lookups, legacy persisted asset status,
Mongo user identity defaults/projected identity validation, authenticated task
import, optional TAPD display labels, offload initialization/paths and parser DTOs.

Wiki/CodeGraph schemas are regenerated from the public Knowledge OpenAPI instead
of resolving nonexistent identifiers. Existing export names remain. Three
unpublished legacy Wiki update success/request/response exports reject all input;
complete legacy response validators are retained. This does not add legacy Core
routes or invent the missing private memory-only generator input. Required inherited
team fields are explicit in eight OpenAPI compositions. Four regression cases
reproduce their omission by the generator before that clarification.

Eight actual schema/parser/counter regressions pass; six fail against the original
source and two baseline response/counter cases pass. Core201/37files, build and
strict check pass on Linux; all tests use synthetic data without external AI.
Production lockfile audit reports zero known advisories. Full development audit
initially reported five in bundled npm dependencies, remediated below; two critical Git-related chains
are corrected by updated packages/overrides. No absence-of-vulnerability claim is
made. The standalone Docker runtime omits optional host/native-LLM peers and npm/npx;
those backends require a separately verified custom image/environment.

A fresh Linux production image starts a synthetic gateway and passes its health
check without external networking or production volumes. Developer package/CLI
absence is asserted. Preparation is distinct from a production cutover and does
not prove complete application/secret-provider recovery. Independent final review,
full native trust and adapter-backed generation backup remain outstanding.


## Development dependency remediation (13 October 2026)

A fresh Linux Node 24.21.0 installation with lifecycle scripts disabled reports
zero known advisories for both the full Core graph and the production-only graph.
The previous five affected libraries were bundled into the npm development
dependency of OpenClaw. The current official npm 12.2.0 archive still includes
vulnerable copies, so a reproducible unbundled archive retains 416 non-metadata
files byte-identically to the integrity-verified official archive and changes only
the documented package metadata. Patched dependency overrides are confined to
npm's tree. The production lock entries are unchanged.

Fresh `npm ci --include=dev --ignore-scripts`, full audit, full strict typecheck,
201 tests across 37 files and build pass on Linux. The unbundled npm CLI reports
12.2.0, performs a synthetic offline install and reads a pinned public package
version over HTTPS. Regenerated Knowledge TypeScript/schema files match their
pre-generation hashes. Artifact regeneration matches its committed SHA-256.
An installation with only the production package metadata and no vendor archive
also succeeds on Node 22/npm 10 and Node 24/npm 11, excluding npm and the optional
host/native peers. The undici override targets only 6.x consumers, preserving
newer major-version requirements.

[Artifact provenance](../MemoryCore/vendor/README.md) documents the upstream
integrity, derived checksum, transformations, pinned libraries and maintenance.
CI reproduces the artifact and fails on changed bytes or known advisories.
This is a development-tooling change; the previously validated production
application remains deployed. It does not establish all npm command behavior,
modern embedded-host interoperability, native provenance or an independent
security review.


## Optional offload HTTP client failure privacy (13 October 2026)

The optional `BackendClient` previously copied non-success/malformed response
bodies into caller errors and selected logs, logged configured URLs and raw
store exceptions, and treated non-HTTPS schemes as HTTP. It now retains HTTP
status and timing without those response bodies/URLs or raw exception text,
and explicitly rejects schemes other than HTTP/HTTPS. Authentication and task/user
headers, successful results and original serialization/network caller exceptions
are retained. HTTP remains supported for existing explicitly configured local
backends; this change does not establish safe use of plaintext remote transport.

Eleven Linux real-loopback/serialization tests pass, including five redirect
statuses with no forwarded requests, credential-bearing URLs, malformed JSON,
401 responses, unsupported schemes and unchanged direct authentication/results.
Ten fail against the original source; one direct-success baseline passes.
Full strict checking/build and 212 tests across 38 files pass. Complete embedded-host integration is not established by these helper tests.

Other offload startup/hook logs and explicit model-I/O telemetry still require
review. Response size limits, aborted-response handling, modern host integration
and remote server end-user authorization are not established by these tests.


## Offload response lifecycle and byte boundary (13 October 2026)

Real Linux HTTP reproduction showed truncated responses leaving calls pending
after socket closure. Invalid-header request construction also left a timer,
per-chunk UTF-8 decoding corrupted split codepoints, and response collection
had no byte limit. The client now handles response errors/aborts/incomplete close,
clears timers on settlement and creates the request before scheduling its timer.
It collects at most 16 MiB of response body bytes, rejects larger advertised or
chunked bodies and decodes UTF-8 once after collection. Exactly 16 MiB of valid
JSON remains accepted. This bounds collected body bytes, not aggregate memory,
concurrency or every malformed encoding case.

Six actual HTTP/fake-timer regressions pass; five fail against the original source
and the exact-limit case is a baseline success. The eleven earlier privacy/auth/
redirect cases remain passing; full strict checking and build pass on Linux.
Other startup/hook/telemetry diagnostics, host integration and end-user server
authorization still require review. No independent final audit is claimed.


## Offload registration diagnostics (13 October 2026)

Selected registration diagnostics no longer stringify or inspect the name/body
of the host hook registrar, print configured user identities or print the backend
URL. They retain method-availability flags, identity-source category and backend
mode. The identity and URL are still used for their intended configuration.
Avoiding registrar string conversion also prevents a custom `toString` from
interrupting registration before hooks are installed.

Four Linux tests run the actual registration function through Node's native
loader with synthetic host API callbacks and isolated temporary directories.
All four fail against the pre-change code for the intended disclosure/conversion
reasons and pass after correction; hook registration remains successful. No SDK
exports are replaced, hooks are not invoked and scheduled collectors are not run.
An initial Vite resolver failure on a conditional legacy SDK import was not
counted as a privacy reproduction. These tests do not establish actual modern
OpenClaw runtime integration. Strict checking and build pass.

Other hook/context-engine/model/reclaimer diagnostics and deliberate model-I/O
telemetry still require review; this is not a complete offload logging audit.


## Offload Opik explicit opt-in (13 October 2026)

A real Linux SDK/loopback reproduction confirmed that shared `OPIK_API_KEY` and
URL environment settings enabled offload tracing and exported a synthetic trace
body even without an Opik plugin entry. Absence of a disable flag was previously
treated as enablement. This establishes unexpected opt-in behavior; it does not
establish malicious intent or actual disclosure from an existing deployment.

Offload tracing now requires `enabled: true` on the `opik-openclaw` entry or its
configuration. An explicit false at either level wins. Initialization reevaluates
disablement before its cache guard, stops new trace creation after revocation and
allows a subsequent explicit enable. Configuration failures disable tracing
without stringifying/logging the exception payload. Other SDK/hook logging and
collector transport/authorization behavior remain outside this correction.

### Migration

Environment credentials alone no longer enable this optional feature. To opt in
intentionally, merge this entry into the host's configuration, keep credentials
out of the configuration document and supply them through protected environment
settings:

```json
{
  "plugins": {
    "entries": {
      "opik-openclaw": {
        "enabled": true,
        "config": {
          "apiUrl": "https://opik.example.com/api",
          "workspaceName": "default",
          "projectName": "agent-memory"
        }
      }
    }
  }
}
```

Enabling this exporter intentionally sends unredacted input/output, model I/O and
message trace content to Opik. Select a trusted collector and review retention,
authentication, redirects, TLS, access controls and the SDK's own logs. The SDK's
normal destination defaults still apply if no collector URL is supplied. Changing
credentials/destination while continuously enabled requires restart or a
disable/enable cycle. Disabling prevents new trace creation; it does not cancel
already queued/in-flight SDK exports or remove remotely stored data. Other
observability backends have separate configuration and are unchanged.

Nine Linux native-loader tests use the actual installed Opik SDK and a synthetic
loopback collector. Five fail against pre-change code and four baseline cases
pass; all nine pass after correction. They cover missing/implicit entries, explicit
enable/disable precedence, disable/re-enable transitions, real synthetic delivery
and failure-payload privacy. Strict checking/build pass; no real memory or keys
are used. This is not an independent final audit or a complete SDK
transport/privacy certification.

## Offload reclamation safety (13 October 2026)

The original reclaimer continued MMD deletion after missing, unreadable or
malformed active-state metadata, despite a comment describing conservative
behavior. It also skipped corrupt reference-index lines/files and could delete
old refs using incomplete evidence. Existing symlinked refs/MMD directories and
log files allowed cleanup to delete or truncate external targets. These flaws
were reproduced only on synthetic Linux fixtures; no production data was used.

Reclamation now requires a regular, readable state file with a valid explicit
`activeMmdFile` (a basename or null). Missing or invalid state skips MMD cleanup.
Orphan detection requires every surviving offload JSONL file and nonempty line
to be readable and valid, with a string `result_ref`. Unknown legacy shapes or
corrupt evidence skip ref cleanup instead of falling back to modification time.
Valid evidence still permits expiry of proven orphans and inactive MMDs while
preserving the active MMD and the minimum retained set of 15 regular MMD files.
The root, cleanup directories and mutated files reject pre-existing symlinks.

Twelve real-filesystem Linux regressions cover these cases: ten fail against
original source, and two cleanup compatibility baselines already pass. All
twelve pass after correction; the full Core suite passes 243 tests in 42 files,
with strict source typechecking and build passing.

This is not race-free filesystem confinement: path checks and later operations
are separate. Trusted roots/ancestors, OS ownership and coordination with writers
and other reclaimers remain required. Hard links, hostile mount changes and
concurrent metadata replacement are not prevented by these tests. Skipping
uncertain cleanup can retain disk usage until an operator repairs the evidence;
no automatic reconstruction or deletion of uncertain data is performed. Other
reclaimer diagnostics and the entire host retention lifecycle still need review.

## Offload backend stage diagnostics (13 October 2026)

Successful L1/L1.5/L2/L4 BackendClient diagnostics interpolated tool names and
call IDs, task labels, MMD filenames/prefixes, node-mapping keys/values and
generated skill names. Synthetic private markers with newline characters were
printed as log lines even with Opik export disabled. These ordinary diagnostic
leaks were reproduced with real HTTP exchanges on Linux loopback, without real
memory, service credentials, external AI calls or a production change.

Selected stage logs now retain counts, lengths and boolean presence/result flags
while omitting those labels/identifiers/mappings. Strict comparisons turn remote
result flags into booleans before logging. The request payloads, response values,
authentication and identity headers remain unchanged. Four regressions, one for
each stage, fail against original source and pass after correction; each checks
actual serialized requests, returned responses and headers, as well as absence
of the synthetic private marker and injected line in collected logs.

This is a bounded diagnostic correction, not complete payload validation or
all-log redaction. The selected trusted backend still receives full request data.
Explicitly enabled Opik tracing still deliberately exports request/response
content; other hook/context-engine/local-model/SDK log paths and malformed remote
response schemas require further review.

## Offload file-selector boundaries (13 October 2026)

MMD read/write/patch/delete helpers previously joined caller-supplied filenames
without validating them. Synthetic Linux tests demonstrated reads, overwrites,
patches and deletion outside `mmds/` through `../` selectors. The ref reader also
accepted parent traversal or an MMD path outside the `refs/` namespace. These
were direct helper reproductions, not proof of arbitrary unauthenticated remote
access or actual production data exposure. Callers include backend/local-model
continuation selections; the entire host authorization chain is not certified.

MMD helpers now accept only nonempty basenames other than `.` or `..`, rejecting
slash/backslash and control characters before filesystem operations. Ref reads
require the exact lexical shape `refs/<basename>` and operate under `ctx.refsDir`.
Ref writes validate their generated basename too. Invalid selectors throw fixed
errors without including selector contents. Ordinary Unicode names, valid
patching/deletion and existing null/false missing-file behavior remain supported.

Seven real-filesystem Linux regressions pass: six escaping/namespace cases fail
against original source, while the normal Unicode/MMD/ref compatibility case
already passes. Full strict source checking and build pass. Fixtures contain only
synthetic data.

Migration: producers/state metadata containing invalid selectors must be fixed
explicitly; no automatic file rename, state repair or path normalization is
performed. A task label containing separators cannot serve unchanged as part of
a filename. The checks are lexical, not descriptor-based filesystem confinement.
Trusted `StorageContext` roots/ancestors and filesystem ownership remain required;
symlinks, hard links, hostile mounts and races can still escape a trusted lexical
path. These MMD/ref checks do not validate every other storage operation or establish
end-user authorization. Additional context/JSONL selector checks are described
below; full lifecycle validation remains outstanding.

## Offload context and JSONL selectors (13 October 2026)

`createStorageContext` previously accepted raw agent/session components with
separators and parent traversal. `switchSession` used a real-session override
without the sanitizer used for parsed session keys; session registration could
persist the unsafe path. The bulk JSONL rewrite helper also trusted `_sourceFile`
metadata, allowing a direct caller to rewrite a parent file or `state.json` and
truncate existing session files. These were reproduced using synthetic Linux
contexts/helper calls, without production memory or external AI calls. They do
not establish unauthenticated remote exploitability or actual deployment exposure.

Context creation now requires valid nonempty agent/session basename components
before building paths. Validation throws before replacing a manager's existing
context, and registration validates real session IDs before persisting a mapping.
Bulk rewrites require `offload-<nonempty-session>.jsonl` basenames for source
metadata, validating every group, including discovered files, before any
asynchronous write starts. Invalid selectors throw fixed errors without their
contents and leave existing files unchanged for the tested rejection cases.

Seven real Linux filesystem regressions pass: six unsafe context/override,
registry and rewrite cases fail against original source; a Unicode-context,
valid registry, worker parsing and normal rewrite baseline already passes.
Full strict source checking and build pass.

Migration: repair invalid raw host session IDs, registry entries and JSONL source
metadata explicitly. No automatic renaming, state rewrite or normalization is
performed. Sanitized session-key behavior is retained, including its existing
normalization/collision limitations. These lexical selectors do not authenticate
users or grant access to tenants. Trusted roots/ancestors, correctly constructed
contexts and filesystem ownership remain required; symlinks/hard links, hostile
mounts and races are not prevented. Bulk rewrites still lack atomic multi-file
commit and writer coordination; IO failures can leave partial changes. Registry
schema/integrity and other state/JSONL lifecycle checks require further review.

## Offload registry integrity (13 October 2026)

Registration previously caught corrupt/unreadable registry errors and then
wrote a new single-session map, risking loss of existing session metadata.
A prototype-named registration key could disappear instead of becoming an own
entry. Lookup returned unchecked `sessionId` values despite its string API;
listing allowed a row's embedded `sessionKey` to override the authoritative map
key, and treated arrays as registries. These are synthetic local helper findings,
not evidence of global prototype pollution, unauthenticated remote access or
actual production data loss.

Registration now rejects an existing registry that cannot be read/parsed as a
non-array object, with a fixed payload-free error, preserving its bytes in the
tested rejection cases. Computed own keys retain prototype-named registrations.
Lookup requires an own registry key, an object row, and a valid nonempty basename
string session ID; invalid/unavailable lookup returns null. Listing accepts an
object registry and object rows, and places the map key after row properties so
metadata cannot substitute another session identity. Extra row fields remain
preserved; this is not full registry-schema validation.

Eight real Linux filesystem regressions pass: seven fail against original
source, while normal Unicode registration, prior-record preservation and valid
lookup/list behavior already pass. Full strict source checking and build pass.
No real memory was used.

Migration/recovery: preserve the original registry and repair malformed metadata
explicitly before retrying registration. There is no automatic reset, older-data
restore or reconstructed session map. The manager's existing handling can ignore
registration failure, while lookup/list retain null/empty unavailable results;
this patch adds no operational alerting. Writes still require coordination and
are not atomic/crash-durable; concurrent writers, links/mounts/races, full row
validation (`offloadFile`/timestamps), namespace authorization and complete
reclaimer/registry lifecycle integrity remain outside this bounded evidence.

## Offload report failure diagnostics (13 October 2026)

The fire-and-forget state reporter interpolated raw upload/scheduling exceptions
into warning messages. An actual BackendClient serialization failure exposed a
synthetic private error message. A thrown object's custom `toString` also escaped
the synchronous catch or rejected the asynchronous failure handler, terminating
a native Node process under strict unhandled-rejection handling.

Both failure paths now log fixed operation-status messages without inspecting
or stringifying exception/report fields. Four native Node/Linux regressions pass:
three fail against original source (private serialization error, asynchronous
coercion failure and synchronous method-access failure); the no-backend case is
a passing baseline. Serialization cases use the actual BackendClient, with no
HTTP request made because serialization fails first. The synchronous case shadows
method access on that actual client to reproduce the scheduling boundary. No
SDK aliases, real memory, credentials or external AI calls are used.

This bounds failure diagnostics only. The selected backend still receives valid
reports, and success logging remains unchanged. A throwing custom logger or
malformed success-report fields can still violate the broader fire-and-forget
contract; these tests do not certify every reporter/host lifecycle or complete
logging privacy. Independent final review remains outstanding.


## Jieba loader version enforcement (Linux, 2026-10-14)

The official locked Jieba 2.0.3 loader expects native metadata 2.0.1. The
license-preserving lazy adapter corrects the expected version and uses official
package-scoped resolution without editing installed modules or native binaries.
Five Linux regressions failed before integration and pass afterward, including
actual source tokenizer segmentation with enforcement, lazy native loading,
wrong native metadata rejection, unsupported main metadata rejection and unchanged
official loader bytes. Strict Core typecheck and build pass; a fresh locked
Linux Node 24 installation reports zero known dependency advisories and all
278 Core tests in 48 files pass. The strengthened lazy-cache assertion passes
in a separate fresh-process run.

The actual Core npm archive was installed into a fresh isolated Linux consumer
with development and peer dependencies omitted and install scripts disabled.
Native enforced segmentation and the compiled tokenizer chunk's internal loader
resolution pass; the official installed loader remains unchanged. This bounded
probe does not load an entire embedded OpenClaw host or test native llama.
Deterministic adapter/license reproduction also passes on Linux from the
SHA512-pinned official archive. See [adapter behavior and migration limits](jieba-loader.md).

The candidate standalone Linux Docker image also loads the actual source tokenizer
with enforcement enabled in a network-denied container, without production volumes.
Six adapter/source/package metadata hashes match the candidate context; the npm
development archive, optional OpenClaw host package and npm executable are absent.
These are candidate source, package and isolated-image checks; production deployment
and a completed independent final review are separate requirements.


## MMD context refresh and diagnostic boundaries (Linux, 2026-10-14)

Seven regressions use real temporary files and the actual OffloadStateManager and
MMD injector. Six fail against the preceding source and all seven pass after the
correction: equal-length ASCII/Unicode tail updates refresh context; unchanged
content skips refresh; intended prompt text is preserved while private filenames
and filesystem error paths are absent from selected diagnostics; caught hostile
coercion is avoided in incremental/full read handlers; the L1.5-wait baseline
preserves existing context. Full strict Core typecheck and build pass. The fresh
Linux full suite passes 285 tests in 49 files. No production memory is accessed
in these tests and this source correction is not a new deployment claim.
[Behavior and remaining boundaries](security-review.md#mmd-context-refresh-and-diagnostics-14-october-2026).
