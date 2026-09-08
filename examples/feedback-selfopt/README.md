# Static policy and isolated memory example

This source example connects bounded static policy rules to the existing source
segment intent/compiler and the real TypeScript SQLite/FTS feedback chain. The
default is off. An explicit fixture runs six scripted turns without a model,
Hermes installation, SDK, HTTP request, or RD-Agent dependency.

It proves an engineering connection only. The supplied rule is an authored
example, not a learned or selected policy. Scripted proposals do not depend on
whether a rule is good. No accuracy, optimization gain, or production effect can
be inferred from the fixture.

## Install and run

Use a checkout containing this example and the optional MemoryCore feedback
adapter. Python 3.11+ uses only its standard library. Use the MemoryCore package's
supported Node version (22.16.0 or later) and normal dependency installation:

```sh
cd MemoryCore
npm install --ignore-scripts
cd ..
python -B examples/feedback-selfopt/demo.py
```

The last command exits silently with code 0. It does not read a policy, resolve
an output/core path, create a database or bytecode cache, invoke callbacks, or
start a child. Interpreter loading of program/standard-library files is not an
application input operation. `--help` explicitly prints usage.

Opt in to the local fixture, using a new output directory:

```sh
python -B examples/feedback-selfopt/demo.py --fixture --core ./MemoryCore --node node --output ./feedback-example-run --policy examples/feedback-selfopt/static-policy.json
```

Omit `--policy` for empty baseline rules. Every run requires a new output
directory and a new database. There is no resume, overwrite, production import,
automatic install, network fallback, model selection, or arbitrary dataset
option. Do not point `--core` at an unrelated or modified implementation without
reviewing it as trusted executable code. Missing dependencies fail explicitly;
the example will not download them. It launches the existing bridge through
Node with `--import tsx`, so a package build is not needed for this source
example. This does not replace normal package build/release checks.

The bridge uses a real `node:sqlite` store with dimensions=0 and requires FTS.
It does not create embeddings or vector tables. The package's existing optional
tokenizer behavior is retained. Type-only embedding imports do not run a model.
The six-turn fixture was checked on Windows with Node 24.14.0. The same runtime
also completed six turns with zero model calls in a fresh isolated Linux
environment using Node 22.23.2 and npm 11.6.0; this verifies engineering
compatibility only, not policy effectiveness. The explicit fixture also needs
permission for `tsx` to create its normal temporary cache;
restricted execution that denies this operation fails before any user turn.

## What runs

Five modules in `shared/` derive from `research/memory_selfopt/`: receipt binding,
canonical trajectory intent, segmented intent, host/stdio adapter, and trajectory
host. Four are byte-for-byte copies. The host/stdio adapter has one explicit
platform change: its child environment allowlist also preserves `SystemRoot`
when present. Windows Node failed native random initialization before JavaScript
without this variable, including outside the execution sandbox. No credentials
or provider settings are added. Original/derived hashes and the one-line
`shared-platform.patch` are recorded in `shared-sources.json`; the repository's
MIT license applies. AST dependency checking verifies only Python standard
library and these five modules. Despite its historical filename,
`hermes_memory_host.py` does not import or install Hermes.

The connection is:

```text
bounded static JSON -> rule texts -> SegmentedTrajectoryIntent
  -> unchanged source/target/authorization compiler -> TrajectoryMemoryHost
  -> existing TypeScript JSONL bridge -> new isolated SQLite/FTS
```

The six public scripted user turns exercise source-bound ADD, temporary NOOP,
UPDATE, a current-memory probe, retirement, and a post-retirement probe. The
first store is empty. Each proposal selects current actual S/T aliases; missing
or ambiguous targets are never invented from expected state. The unchanged
compiler and store enforce their contracts. There is no alternative intent
algorithm, model judge, or permission bypass for a candidate rule.

The answer consumer reads only the actual serialized current request, parses
the existing memory lines, and returns `received_memories`. It cannot consult
the database, fixture schedule, labels, or future user turns. Probe answer
history is empty. Returning injected strings is a deterministic transport
exercise, not a language-model QA measurement.

## Delivery is explicitly a fixture

The unchanged host gate expects an HTTP-shaped completion. The example calls
`observe` on the exact bytes passed to a local consumer, verifies the consumer's
matching ACK, and only then supplies a **simulated** 200 to the gate. No HTTP or
SDK operation happened. Its old `delivered=true` field is never exported alone.

Every row, including failed rows, wraps the unmodified host output with:

```json
{
  "context": "engineering_fixture",
  "delivery_kind": "local_inprocess_fixture_sink",
  "gate_status_kind": "simulated_http_shape",
  "actual_provider_delivery": false,
  "http_requests": 0,
  "sdk_calls": 0,
  "model_calls": 0,
  "token_usage": null,
  "token_usage_status": "not_applicable_no_model",
  "host": {}
}
```

This proves receipt by the local deterministic consumer only. It does not prove
model delivery, consumption, intent quality, or effectiveness. Do not strip the
wrapper or adapt these records into real-provider wire manifests or DeliveredSets.
Callbacks and checked-out source are trusted local code, not sandboxed plugins.

## Static policy

The exact JSON fields are `schema_version: 1`,
`artifact_kind: "static_memory_rules"`, `generation` (0..3), and `rules`.
Generation 0 requires empty rules. Rules have exactly `rule_id` and `text`, with
unique IDs R1..R8. Limits are 4096 bytes/file, eight rules, 512 UTF-8 bytes/rule,
and 2048 rule bytes total. Duplicate keys, unknown fields, invalid Unicode,
excessive nesting and nonfinite JSON are rejected. Whitespace is not repaired
into a different rule. The shared `freeze_rules` remains the final rule-capacity
check. Configuration is validated before creating the run directory or child.

Rule texts are frozen once, in order, and passed into `policy_rules`. The shared
system prompt and authorization guards are unchanged. The output records the
raw artifact hash and the canonical `{generation,rules}` hash; neither grants
execution permission or says the rule works.

The SDK's `PolicySnapshot` can be exported to this format by mapping `version`
to `generation` and each `(rule_id, text)` tuple to a rule object. The runnable
`optimize.py` example performs this conversion without changing the classifier
or the storage guards. No external evolution framework is required.

## Evidence, limits, and failures

The new directory contains configuration, wrapped `rows.private.jsonl`, actual
local `deliveries.private.jsonl`, `bridge-audit.jsonl`, summary, a failure record
when applicable, and the isolated SQLite file. Rows preserve original sources,
decisions, snapshots, target/version bindings, injection, answers and stage
timings. Retirement keeps a null current content/scope head and historical
revisions; it is not physical privacy erasure.

These outputs are **private** source/history records, not safe public telemetry.
The CLI prints only bounded counts, fixed codes and hashes. The bridge audit
hashes request arguments and returned data; it is not a raw SDK or HTTP trace.
Local callback attempts and byte-consumption attempts are counted separately.

The runner is limited to six turns, one active logical memory, one Node child,
one database, one classifier and one sink callback per turn, 64 bridge attempts,
64 KiB per local request, 2 MiB per JSON file and 8 MiB total JSON evidence.
Existing source/history/query/injection/SQLite limits remain unchanged. The
fixture deadline is 120 seconds, with 12 seconds reserved before admitting each
RPC for its existing eight-second wait and child cleanup. OS process creation
or filesystem stalls are not forcibly preemptible; this is not a hard real-time
process supervisor. There are no retries and no concurrent turns.

Existing output paths and links/junctions are rejected. Failures preserve known
mutations and the last host evidence; they do not replay a writer, reconstruct
missing turns, or claim a rollback. Cleanup errors do not skip other final
exports. Each evidence file is written exclusively; failed exports are not
overwritten or silently truncated. Summary and failure evidence are attempted
independently, subject to the same storage availability and byte caps. Off mode
keeps the caller's baseline. Enabled failure stops the fixture with nonzero exit.

## Six new checks

From this directory, with MemoryCore installed, run once into new evidence:

```sh
python -B -m unittest -v test_example
```

`E5_F3_CORE` can explicitly select the installed MemoryCore checkout;
`E5_F3_TEST_OUTPUT` can select a new test-evidence directory. Defaults locate
MemoryCore in the same repository and retain evidence in `new-test-evidence`
beside this example. Existing per-test output directories reject a rerun; use
a new evidence directory rather than overwriting prior evidence.

The six tests cover default off, static-policy boundaries, declared module
provenance and actual rule injection, exact local ACKs/fixture labels, one new
real six-turn TS/SQLite chain, and failure/capacity/export handling. The real
integration is not silently skipped if prerequisites are absent. Fault-test
rows are separately labelled synthetic fixture evidence. Table cases and callback counts are not independent research samples.

Rollback is omission of `--fixture` or cessation of this isolated example.
Do not remove user history or migrate a production database as rollback.

## SDK to real SQLite feedback loop

Install the SDK from **this checkout**, then run the companion fixture from the
repository root (Python 3.11+):

```sh
python -m pip install ./sdk/memory-core/python
python -B examples/feedback-selfopt/optimize.py --fixture --core ./MemoryCore --output ./feedback-optimizer-run
```

Without `--fixture`, it exits silently without creating a store. The opt-in run
uses two fresh six-turn databases. An explicitly scripted baseline misses the
third-turn UPDATE; the fourth-turn probe receives the stale value. The adapter
measures actual commits, scoped active snapshots, source hashes, continuity and
local sink acknowledgements against the six public authored statements. It
rejects missing observations and unannotated contents, rather than guessing
semantic correctness. One current error and correct ADD/NOOP controls are sent
to `FeedbackOptimizer`. A **scripted**, inactive candidate is exported and run in
a second database, then the SDK evaluates the measured comparison and rolls
back any adopted policy.

Expected deterministic fields: `completed_turns=12`, `before_correct=4`,
`after_correct=6`, corrected support `D1/3/1`, final policy version 0, and zero
HTTP/model requests. This is a planted fault, so the 4-to-6 result is **not**
self-optimization efficacy. Actual local timing is retained; the 1.5x p95 cost
gate may reject adoption on a busy machine. That outcome is reported, never
rewritten to pass. The annotation projection is fixture-specific; a real host
must supply its own reviewed labels, source/trace authentication, delivery and
cost records using the [SDK contract](../../sdk/memory-core/python/docs/feedback.md).

Run the integration checks from this directory after installing the SDK:

```sh
python -B -m unittest -v test_example test_optimize
```

The new optimization test also rejects changed sources, wire hashes, state
continuity, unknown content and missing turns. Repeating `test_example` requires
a new `E5_F3_TEST_OUTPUT` directory, because existing evidence is preserved.
