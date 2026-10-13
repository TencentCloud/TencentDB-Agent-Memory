# Security review scope and findings

This records source review, automated checks and reproduced transport behavior
for the contribution based on upstream v2.0.2. It is not a completed independent
security audit or a certification that all malicious behavior and vulnerabilities
are absent. Software origin, contributor names and comment language are not
evidence of spyware.

## Confirmed and corrected behavior

A two-server HTTP regression reproduced credential forwarding in the upstream
Hermes stdlib client and Python Opik importer: a redirect to a different origin
received the synthetic `Authorization` header. Both clients now reject redirects
instead of following them. Normal GET/POST requests continue to work. Eight
stdlib regression tests cover direct requests, five redirect statuses for each
client and method, and Hermes error-log privacy. Hermes no longer logs response
bodies, application error messages or transport exception text; callers can still
inspect the original response or HTTP exception.

Run these checks without third-party Python packages:

```sh
python3 -m unittest discover -s MemoryCore/hermes-plugin/tests -v
```

This hardening deliberately rejects even same-origin redirects. Configure the
canonical endpoint directly. TLS certificate verification remains the Python
stdlib default; these new tests exercise HTTP redirect and log behavior, while
the separate SDK tests exercise actual HTTPS trust and hostname verification.
Configured endpoints and environment proxy settings remain operator trust inputs.
This is not an SSRF sandbox for arbitrary operator-selected service URLs.

## SDK and Panel follow-up

Two local HTTP servers also reproduced cross-origin forwarding of the
`x-tdai-user-key` header and request body in both TypeScript SDK transports and
the Panel metadata transport after HTTP 307 responses. These clients now reject
redirects. The same policy applies to SDK STS/COS requests, Panel Knowledge calls
and startup LLM-binding synchronization, where forwarded request bodies can
contain service credentials or private data. Configure canonical URLs directly;
even same-origin redirects are rejected.

The Panel metadata transport also copied request/response content into its
logger, despite field-name based masking. It now logs operation/status/timing
information without serializing payloads or business-error messages. Callers still
receive the original responses and errors. This is not a whole-project log
redaction claim.

Thirty additional SDK tests exercise direct requests and five redirect statuses
for v2 POST, v3 POST/GET, STS acquisition and signed COS reads (36 SDK tests total).
COS read fixtures use synthetic credentials and real trusted HTTPS loopback
servers; no real cloud account or remote bucket is accessed. Twenty-two additional
Panel tests cover metadata/Knowledge/startup binding redirects and success/error
payload privacy (24 Panel tests total). SDK build and Panel typecheck/build passed.

## Optional importer and injected Python clients

The standalone asset importer also forwarded its user key and private POST body
across redirects. It now rejects redirects and omits response-body excerpts from
malformed-response exceptions, which the CLI can otherwise print. Eight new real
HTTP tests cover direct success, five redirect statuses and two malformed-response
privacy cases (32 Panel-hosted tests total).

Python SDK transports normally use httpx clients that do not follow redirects.
However, a caller-supplied client with `follow_redirects=True` forwarded the custom
user-key header and private body across origins in a real HTTPS reproduction.
The v2/v3 synchronous/asynchronous POST and v3 GET transports now explicitly set
`follow_redirects=False` per request and reject redirect responses, regardless of
that supplied client's default. Thirty-six real HTTPS regressions cover these six
paths, direct success and five redirect statuses (41 Python SDK tests total).
This does not control arbitrary caller-supplied httpx event hooks or transports.
Python STS and signed COS readers also explicitly reject redirects, including
injected clients and the retry after a 403 response. Twenty-eight additional real
HTTPS tests cover sync/async STS acquisition and file reads, direct success, five
redirect statuses, retry redirects and log privacy (69 Python SDK tests total).
Fixtures use only synthetic temporary credentials and loopback certificate trust.
COS logs omit bucket/prefix/path data, and failure exceptions omit response bodies.

The optional OpenClaw search/file tool handlers copied private queries, session IDs,
file paths and error text into their logger. Six synthetic success/failure tests
exercise the actual handlers: logs now contain operation/count information while
original content and error results remain available to the caller. A further actual
capture-hook regression confirmed that session identifiers were logged; the hook
now logs only operation/message counts, preserving the submitted session identity
and captured content (41 Panel-hosted tests total). This does not assert
whole-plugin log privacy: other hooks and external SDK/host logging need review.

## Automated source review

Semgrep OSS 1.180.0 scanned 1,206 tracked files using 272 rules from
`p/security-audit` and `p/secrets`, with metrics disabled. The initial scan
reported five warnings. Dynamic urllib use led to the concrete redirect tests
and fixes above. A targeted rerun of both Python clients and the Python SDK
reported two remaining warnings, with no parsing errors in that scope:

| Warning | Assessment |
| --- | --- |
| SHA-1 in the Opik importer | A short deterministic session-ID suffix, not a password hash, authentication token or cryptographic integrity check. It has no collision-resistance guarantee and must not be reused as an authorization boundary. |
| SHA-1 in the Python COS reader | Part of the existing COS V5 signing protocol. Replacing its algorithm locally would break protocol compatibility; see the [official signing specification](https://www.tencentcloud.com/document/product/436/7778). This reader is distinct from the removed Proxy COS factory. |

The whole-tree scan reported seven parsing limitations: the Panel metadata
OpenAPI file; Core gateway configuration and two metadata routers; two Proxy
tests; and the TypeScript SDK v3 export file. The OpenAPI file parsed successfully
with both js-yaml and PyYAML, so no syntax change was warranted there. TypeScript
build/typecheck evidence is recorded separately. A partially parsed file has
reduced static-analysis coverage even when its normal compiler accepts it.
Rule-based scanning does not establish complete coverage or absence of covert
behavior. Rule definitions and native dependency implementations require their
own trust assessment.

## Data-flow and operational limits

See [architecture and data flow](architecture-and-data-flow.md) for configured
LLM providers, exporters, local logs and authentication/tenant boundaries. Native
OKF exchange does not execute imported runners or invoke an LLM. The removed
private Proxy extension is absent from this tree and the tested deployment;
source-level integration checks do not audit every remaining compiled dependency.
No covert exfiltration destination was established in the reviewed integration
paths, but that is a bounded observation, not a whole-program guarantee.

Credentials stored by Knowledge remain reversible base64 in SQLite. Privileged
processes can inspect child environments. Filesystem guards assume a trusted
parent and a single writer. The Git swap and OKF journal do not provide complete
crash durability or an atomic transaction spanning SQLite and filesystem state.
The backup archive passed integrity verification; a complete disaster-restore
rehearsal remains outstanding.

Core has no root `tsconfig.json` or whole-Core typecheck command; its build is
not evidence of a complete TypeScript typecheck. The OpenClaw client configuration
typechecked successfully. The Pi client typecheck could not complete in the
verified workspace because its host-provided `@earendil-works/pi-coding-agent`
peer dependency was absent. Do not interpret supported component checks as
verification of every optional integration.

A separate independent final reviewer must still assess the complete candidate,
especially native artifacts, externally enabled exporters, deployment-specific
permissions and integrations not covered by the recorded tests.

## Bounded native artifact verification

Seven selected npm archives (CodeGraph wrapper/Linux x64/macOS arm64,
`better-sqlite3`, and sqlite-vec wrapper/Linux x64/macOS arm64) matched the SHA-512
integrity values in the committed lockfiles. The installed macOS CodeGraph and
sqlite-vec binaries and the running Linux production binaries matched SHA-256
hashes of their corresponding archive entries. Archive inspection did not execute
install scripts or native code. This proves consistency with selected pinned
artifacts, not safe behavior, publisher identity or source reproducibility.

The `better-sqlite3` install lifecycle can obtain a separate prebuilt binary;
verifying its npm source archive does not cover that download. Mutable Node base
images, system packages, native build tools and remaining native packages still
require separate provenance/reproducibility review. No comprehensive compiled
supply-chain audit is claimed.

## Core whole-source TypeScript probe and error handling

`MemoryCore/tsconfig.audit.json` provides a strict, no-emit probe of `index.ts` and
`src/**/*.ts`, with dependency declaration checking skipped and test files excluded.
Run `./node_modules/.bin/tsc -p tsconfig.audit.json --pretty false` in MemoryCore
following locked dependency installation. This check currently fails: the initial
probe reported 224 diagnostics; targeted corrections reduced this to 183. Missing
OpenClaw host declarations account for some failures; others involve generated
schema references, SDK/provider types and source contracts. These diagnostics are
not all established runtime vulnerabilities. Core build/tests are not evidence of
a passing whole-source typecheck, and Core CI does not claim that check passes.

The probe exposed a concrete runtime defect: three synthetic tests of actual gateway
methods received `ReferenceError` instead of the intended `SkillCoreError` when
instance dependencies or LLM configuration were absent. Importing that error class
restores the structured failure. Missing store type imports and three duplicate
logger properties were also corrected. All 27 Core regression tests passed locally;
no storage initialization or LLM request is used in the new error-path fixtures.

Two generated parser exports have confirmed runtime failures with synthetic input:
`listWikiMutationRequestSchema` references undefined `wikiListRequestSchema`, and
`listCodeGraphMutationRequestSchema` references undefined
`codeGraphListRequestSchema`. Both produce `ReferenceError`. The Kubb configuration
points to `MemoryCore/docs/team-api-仅memory.yaml`, which is absent from the tracked
source. These exports remain unresolved: restoring the authoritative generator
input/API contracts and regenerating consistent schemas/types is required. This
parser reproduction does not establish that deployed route handlers use these
exports or fail in the same way.

## Knowledge entity tenant error responses

The actual Knowledge get/update handlers returned a distinct `403` response when
an explicitly supplied team differed from a stored resource, revealing that the
resource existed. They now return the identical `404` envelope used for absent
resources, consistent with the asset-layer non-disclosure policy. Four synthetic
handler regressions check foreign/missing equality, no foreign update, and unchanged
own-team reads/updates. All 31 Core tests and the build passed locally and in Ubuntu CI. Service keys
remain privileged management-plane credentials: this change does not make a shared
service key a tenant-bound credential or change legacy unscoped management calls.

## Native SQLite source-build rehearsal

A bounded macOS arm64 rehearsal compiled `better-sqlite3` 11.10.0 from the npm
archive after verifying its SHA-512 against the committed Knowledge lockfile.
The archive was extracted with path/type/size checks. `node-gyp rebuild --release`
used Node 22.22.3 and cached headers with network access denied; the npm install
lifecycle and separate prebuild download were not invoked. Synthetic in-memory
read/write, transaction, rollback and integrity checks passed with networking
still denied. Four compiler warnings remain. This establishes that the selected
source can build and pass these checks on that platform; it does not establish
compiler/header provenance, reproducibility, comprehensive native safety or
identity of the deployed Linux binary. Existing production artifacts were not
replaced by this rehearsal, and the default install/prebuild policy is unchanged.

The whole-Core probe also identified a missing re-export of the already defined
`ApiTraceProfile` type and unreachable legacy conversation-count code following
the current scoped `countL0` return. Restoring the type export and removing that
never-executed block reduced diagnostics from 213 to 205 without changing the
count implementation. The Core build passed; whole-source typecheck still fails.

## Recall adapter capabilities and log privacy

Actual recall-hook fixtures reproduced private FTS queries and record IDs in debug
logs, and empty recall when a store advertised native hybrid search without its
optional `searchL1Hybrid` method and no client embedder was available. Native
hybrid selection now requires the method as well as the capability flag; the
unsupported combination falls back to keyword search. Four regressions cover
keyword log privacy, that fallback, unchanged native hybrid without a client
embedder, and omission of backend error payloads. Query/result values are preserved
for the caller and store; logs keep operation/count/timing data. All 35 Core tests
passed locally. The strict probe now reports 203 diagnostics and still fails.
This bounded fix does not certify every hook, exporter or host logger.

## OpenClaw registration logging

The actual optional-client registration function logged endpoint/instance/tenant
configuration, session keys and caught recall/capture error messages. Two synthetic
registration tests exercise both registered callbacks in success and failure cases.
With host/SDK/hook stand-ins, they reproduced the leaks before correction and now
verify omitted private values, preserved prompt/session forwarding and unchanged
callback results. Registration logs retain settings flags, counts and timings.
The separate OpenClaw TypeScript check and all 41 Panel-hosted tests/build/typecheck
passed locally. These fixtures do not validate the full OpenClaw host or live SDK;
SDK transport behavior is tested separately. This optional-client correction
requires source installation and does not require restarting the Core service.

## Generation provenance logging and skill contracts

The actual best-effort provenance writer copied backend error messages into warning
logs. Three synthetic failure cases reproduced this before correction; five cases
now verify payload omission, preserved log-before-reference ordering, no reference
write after a failed log, and successful sync/async reference callbacks. Failure
remains best effort and does not make memory generation fail.

Existing skill frontmatter behavior now has an explicit `SkillFile` type; returned
name/description use the same validated local values instead of unknown mapping
properties. Optional legacy candidate fields share their existing queue contract.
The provenance callback type reflects its already supported sync/async behavior.
Two parser regressions cover YAML value coercion/CRLF/resource/body round trips and
continued rejection of unsupported resource types. All 42 Core tests and the build
passed locally; the strict probe reports 189 diagnostics and still fails. These
changes do not restore the missing generated Wiki/CodeGraph API contract.

## Linux native SQLite build and service validation

The Linux x86-64 candidate uses Debian 12 and Node 22.23.3 (ABI 127), matching the
production runtime. `better-sqlite3` 11.10.0 was compiled from its npm source archive
after locked SHA-512 verification. Compilation used the production Node binary
and headers, GCC 12.2.0 from an existing Debian build-toolchain image, and denied
networking. The candidate runtime image replaces the default SQLite addon with
that compiled artifact; this is a source-only derivative of the verified Hub image.

The default addon load passed in-memory read/write, transaction/rollback, FTS5 and
integrity checks (SQLite 3.49.2). The actual Knowledge server started with isolated
data and synthetic credentials, then passed authenticated six-file native OKF
import/export byte equality and cleanup, foreign-team `404` and invalid-key `401`.
No production volumes or external networking were available during these probes.

Knowledge standalone/combined Docker builds now request native source compilation
with their image's Node headers. Knowledge Ubuntu CI applies the same policy before
its full test suite. Direct npm installation outside these builds can still select
a release prebuild. This removes the separate better-sqlite3 prebuild from the
active candidate, but does not audit the compiler, cached build image, headers,
CodeGraph kernel or other native packages, establish bit reproducibility, or
certify absence of malicious behavior. Old image layers/predecessors are retained
for rollback; no erasure of previous artifacts is claimed.

## OTLP gRPC authentication configuration

A Linux loopback collector received environment credentials instead of the
explicitly configured credentials for the gRPC trace/log exporters. The upstream
initializer passed HTTP `headers` to gRPC constructors, which accept `metadata`;
those options were ignored. The initializer now builds gRPC Metadata using the
exporter base package's public API. This already locked package is declared as a
direct dependency; its version and archive integrity are unchanged.

The regression starts an actual local HTTP/2 gRPC collector, emits a trace and a
log through the actual SDK initializer, flushes/shuts down, and checks both export
RPCs receive configured authorization and tenant metadata despite conflicting
common environment credentials. Before the fix, authorization came from the
environment; after it, both requests match explicit configuration. All 43 Core
tests and the build passed on Linux with external networking disabled. The fresh
strict Core probe still fails with 193 diagnostics; this fixes two exporter
configuration errors and does not establish whole-source type safety. HTTP
exporters retain their existing header configuration and integration regression.
These tests use synthetic data and do not contact a production collector.

## Telemetry initialization log privacy

Two actual initializer regressions on Linux reproduced logging of configured
collector/Langfuse URLs (including synthetic query credentials), service/tenant
identifiers, and invalid gRPC metadata keys in failure diagnostics. Initialization
messages now retain exporter state and the effective protocol without those
configuration values. The main, ClickHouse and Langfuse initialization catches
omit raw exception payloads. Successful initialization and failed initialization
return values are unchanged.

The tests use synthetic settings, emit no telemetry, and run without external
networking. All 45 Core tests and build passed on Linux. This bounds the claim to
application initialization messages; SDK debug diagnostics, runtime exporters,
telemetry content and remaining logging paths require their own review.

## Knowledge creation nullable-field contract

The Core metadata gateway passed omitted `summary` and `user_id` directly to
backends even though its entity contract requires nullable fields. The actual
Mongo backend consequently constructed a persisted document and create response
without those fields; SQLite already supplied `null` defaults. The gateway now
normalizes both omitted fields to `null` before calling any backend. Explicit
values and rejection of an empty user identifier are preserved. No migration or
authorization policy change is required.

Four regressions exercise the actual handler and Mongo backend entity construction
with only its database transport mocked. Two failed before the correction. This
is not a live Mongo server/integration claim. All 49 Core tests and build passed
on Linux without external networking; the fresh strict probe still fails with
189 diagnostics, one fewer after correcting this source contract.

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


## Upstream HTTP error diagnostic privacy

Upstream commits through `b1f79fc4714b1e20a1ab94ec6b98e50100af6dc4` are preserved.
The runner keeps the new HTTP status diagnostic, but excludes provider URLs,
messages and response bodies from its logs and uses a fixed report error summary.
A real SDK loopback HTTP 400 regression failed with the upstream logging block
and passed after correction. Original exceptions are still returned to callers;
this is not whole-application log redaction. FTS5 health response tests cover
three synthetic capability states; actual offload host interoperability remains
outside this test evidence. Linux Core: 78 tests/build pass, strict typecheck
still fails with 183 diagnostics.


## Local state identity boundaries

The in-process state backend previously concatenated identity components with
colons and selected instance records by a raw string prefix. Different team/agent
or instance/timer tuples could therefore collide, and purging one instance could
remove another instance with a matching prefix. Six synthetic Linux regressions
reproduced these collisions before correction and passed afterward. Keys now
encode each component separately; missing, empty and literal underscore identities
remain distinct. Listing, expiration and purge use an exact encoded instance
boundary. This is a storage isolation correction, not end-user authentication or
proof of an externally exploitable route. Opaque timer members are not redefined;
callers' separate timer-member parsing and lock-key construction need review.

The public state factory explicitly rejects Redis (not shipped) and unknown types
instead of loading an absent private integration or falling through to local.
Six factory tests cover three unknown selectors, Redis credential non-access,
missing Redis config and ordinary local buffer operations; five assertions failed
before correction. Redis already failed with the absent integration; this does
not remove a working public Redis implementation. Local state remains volatile,
including buffers/queues/timers/locks, with no persistent-key migration. Quiesce
and drain work as appropriate before restart; preserved memory databases are
separate. Linux Core90/build pass; strict Core still fails with181 diagnostics.


## Worker lock identity boundaries

PipelineWorker previously constructed lock scopes with raw colons and braces and
used a literal underscore for missing team/agent identities. Different identity
tuples could contend for the same lock, causing unintended exclusion/parking;
embedded braces could alter Redis hash-tag grouping. The worker now encodes
complete identity tuples with distinct missing values, and encodes session/MMD
suffixes. A non-string MMD target is rejected without implicit string coercion.
L1/flush session locks, L2/L3 shared agent locks, instance granularity and the
worker's lock-free offload stages retain their policy. Legacy data/profile tenant
resolution remains available. Encoded lock names can still reveal identifiers
when decoded; this correction does not redact worker logs.

Nine Linux tests exercise the actual lock-scope method and real local lock
acquisition. Six assertions failed before correction; all pass afterward, as do
99 Core tests/build. Strict checking still fails with181 diagnostics. No live
Redis/Cluster integration or full worker scheduling was tested; storage/lock
collisions are not proof of externally exploitable APIs or tenant authorization.
Stop old consumers and drain work before upgrading; do not mix old and new key
formats. Other lock constructors, timer-member/profile parsing and exporter/
worker logs require separate review.


## Pipeline timer member identities

The timer builder previously discarded a partial team/agent context, merging
otherwise distinct timer members. An unscoped literal session resembling scoped
metadata could also be decoded as another session and tenant. New timer members
always encode their session and each supplied context field, including empty
values; missing values stay absent. Profile inference is preserved when neither
context field is supplied. Internal timer labels are restricted to ASCII letters,
digits, underscore and hyphen to prevent delimiters from changing parsed identity.
The decoder retains old unscoped/scoped/profile support; the property map has no
prototype. Older ambiguous or malformed legacy metadata is not made trustworthy
by this correction, and no end-user authorization is inferred from timer fields.

Eleven synthetic Linux tests use the actual builder/parser and local timer store.
Nine assertions failed beforehand; all pass after correction, including ordinary
classification, punctuation and legacy/profile compatibility. Core110/build pass;
strict Core remains failing with181 diagnostics. No live remote timer scanner,
full gateway callback scheduling or OpenClaw integration is established. Stored
legacy member names are not auto-renamed/cancelled: stop old consumers and drain/
recreate transient timers during upgrade. Other offload/shard/profile grammars,
locks and identifier-bearing logs still require review.


## Skill initialization contracts and error privacy

Skill initialization rechecks enablement after awaiting storage readiness and
stops before touching SQLite if the module was disabled while waiting. A null
resolver result becomes an absent resolved configuration rather than proceeding
with partially initialized tables. Capability probing uses the injected storage
adapter type, avoiding the removed legacy COS config and duplicate credentials.
The resolver receives its complete logger contract. Wiring/LLM-runner-build
failure diagnostics omit raw exception messages while preserving nonfatal
containment and clearing unavailable skill components.

Five Linux tests use the actual core methods and resolver: disablement during
readiness, injected COS capability, obsolete config non-access, backend-error
privacy and successful real in-memory SQLite/local-storage initialization with
no LLM. Four assertions failed before correction; all pass afterward. Core115/
build pass; strict Core remains failing with163 diagnostics (181 before these
contract fixes), without suppression or private stubs. The synthetic COS adapter
proves type/capability selection, not connectivity/authentication; the public COS
factory remains unsupported. Other initialization/gateway/exporter logs and
complete skill lifecycle/remote storage interoperability still need review.

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

SceneExtractor no longer automatically wipes scene files and restores the latest
filesystem snapshot after a runner failure. The selected snapshot could belong to
an older extraction when the current scene directory is empty; restoring it also
reverts writes made after the pre-run snapshot. Two actual Linux filesystem tests
reproduce both losses before correction and preserve current files afterward.
Pre-run filesystem backups remain available for explicit operator recovery.

On failure, partial runner writes may remain. Pause affected extraction/recall,
inspect the current files and a verified snapshot, and plan recovery without
replacing newer writes. There is no atomic generation transaction or compare-and-
swap recovery, and adapter-backed snapshots remain unsupported. The explicit
BackupManager restore helper is still destructive; it must not be invoked as an
automatic failure handler. No production data restore was performed for these tests.


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


## Development package-manager remediation (13 October 2026)

The five remaining Core development dependency advisories are removed from the
verified installed graph, without suppressing audit results or dropping the
actual SDK/native type dependencies. OpenClaw's npm dependency is supplied as an
integrity-verified, reproducible unbundled npm 12.2.0 archive. Its CLI code and
licenses are retained unchanged; only documented package metadata is modified.
The patched versions are installed separately through the committed lockfile
and scoped npm overrides. Production dependency entries are unchanged.

A fresh Linux installation reports zero known advisories for full and production
graphs; strict typechecking, 201 tests, build, basic npm CLI operations and
Knowledge generation checks pass. The archive can be reproduced and unpacked
for review using [the provenance instructions](../MemoryCore/vendor/README.md).
Registry checksums establish correspondence with pinned published bytes, not
trustworthiness of those bytes. No comprehensive independent audit is claimed.
See [the required final review scope](final-review-scope.md).


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
Full strict checking/build pass. Complete embedded-host integration is not
established by these helper tests.

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


## Native Jieba loader compatibility

The official 2.0.3 loader's stale expected native version causes fallback
tokenization when operators enable native version enforcement. A reproducible,
licensed lazy loader adapter corrects that comparison while retaining package-
scoped native/WASI loading and operator flags. Unsupported main metadata and
mismatched native metadata are rejected in Linux regressions; installed official
loader and native bytes are not modified. This corrects tested compatibility,
not the broader trust or reproducibility of native binaries.
[Packaging, verification and index migration limits](jieba-loader.md) are explicit.


## MMD context refresh and diagnostics (14 October 2026)

The incremental injector previously compared only content length and the first
64 characters. Equal-length ASCII and Unicode changes after that prefix left the
injected task context stale. It now compares SHA-256 over the complete decoded
UTF-8 content. Unchanged content still skips refresh; replacement retains a single
marked context message. Fingerprints are runtime-only, contain no plaintext prefix
and require no stored-state migration or automatic document rewrite. Hashing reads
all decoded content; this is change detection, not an authentication mechanism.

Successful/incremental injector diagnostics previously printed private MMD filenames;
filesystem failure diagnostics printed exception paths. A caught object whose
`toString` throws also escaped both read-error handlers. These diagnostics now use
counts, presence flags and fixed failure messages without filename or exception
coercion. Intended task text/filename in the prompt and explicitly enabled Opik
export remain unchanged. Other token-counter, hook, pipeline, storage and runtime
logs, throwing logger callbacks, file read/write races and filesystem confinement
remain outside this correction.

Seven actual Linux filesystem/manager regressions pass: two equal-length tail
updates, prompt-versus-diagnostic privacy, filesystem error privacy, two caught
coercion failures and the existing L1.5-wait behavior. Six fail against the preceding
source; the L1.5 baseline passes there. These are synthetic helper/manager tests,
not proof of a completed embedded-host integration or unauthorized remote exposure.
