# Isolated SQLite feedback chain

This optional source-level adapter records provenance and atomically applies
feedback to a separate MemoryCore SQLite store. It is not registered with the
Gateway, an LLM tool, or a production plugin. Omitting `mode` keeps it off.
It does not classify user intent, optimize a policy, or prove memory usefulness.

## Host contract

Create a new independent `VectorStore`, then a `SqliteAtomicMemoryPort` and
`SqliteEvidenceChain(port, port.getRawDb(), { mode: "isolated" })`. All three
must share the same raw database connection. Use explicit team, user, agent and
task scope; do not point the adapter at an existing production store.

- `captureSource` captures a trusted host's current user message before a model
  proposal. `addFromSource` creates memory from a uniquely occurring verbatim
  span of that message; the first turn requires no fabricated delivery receipt.
- `composeInjection` accepts actual scoped retrieval hits and creates an
  immutable receipt containing complete current versions. The host must verify
  actual downstream delivery separately: composing a receipt does not prove
  delivery, model consumption, or semantic permission.
- `captureUserTurn` binds later user feedback to the latest rendered receipt in
  the same scope/session. `apply` requires the target and expected versions from
  that receipt for update or logical retirement. Source spans use Unicode code
  points, not UTF-16 offsets. A missing target is not an instruction to add.
- `seed` is an explicit fixture adoption operation, not a production import.
  `support`/`refute` append evidence without changing memory contents.
- Catch fixed `ChainRejected` and `AtomicMemoryPortError` codes at the host
  boundary. Off mode delegates unchanged to the caller. Enabled integrity
  failures reject; they do not replay a writer or inject a previous baseline.

The host owns authentication, real message ordering, event IDs, target selection
authority and delivery checks. This adapter verifies provenance consistency;
it cannot decide whether natural language actually authorizes a persistent edit.

`chain-stdio-bridge.ts` is an optional bounded JSONL interface for a trusted local
host. It requires `--isolated`, an absolute new database path (or a matching
verified isolated marker), and explicit scope. It supports source capture/add,
seed, compose, receipt context, feedback, inspection, snapshot and shutdown. It
does not expose SQL, arbitrary retrieval hits, or a model/provider client.
Responses containing memory or source-derived state are private data, not safe
public telemetry. Keep this interface out of model tools and public services.

## Atomicity, limits and limitations

L1, FTS, vector invalidation, revisions, current heads, source-use quota and events
commit in one synchronous transaction. Do not call the store's separately
transactional upsert/delete inside it. Updating without a new embedding removes
the old vector; this adapter uses FTS and does not generate replacement vectors.

Exported limits can be inspected; supported overrides only lower them. Defaults
include 256 retained chains/receipts, 20 normal revisions plus a retirement
marker, 20 evidence events per version, 4096 ordinary events plus 256 retirement
slots, at most 5 active source-added memories per domain, candidate k≤20,
injected k≤5 and ≤8 KiB injection. The atomic port limits L1 to 10,000 and FTS
to 20,000 rows. The bridge additionally bounds input/output to 64/32 KiB and
256 requests. Each output frame must finish within 1 second and an active run
deadline interrupts a pending write. A broken or timed-out output is closed;
the caller may receive no final error frame and must also check the exit status.
Startup errors and idle-input timeout reports get one bounded output attempt.
Capacity failures reject without silently truncating evidence.

Revisions are append-only and contain historical memory content. Logical
retirement is not physical privacy erasure. TTL rejects stale receipts but does
not reclaim retained capacity. There is no compaction service, cross-backend
transaction implementation, L2/L3 derived-memory invalidation, production
migration, or automatic policy training. A Tencent VectorDB integration needs
its own conditional-write and transaction contract.

## Validation and rollback

From `MemoryCore`, use the repository's normal `npm install --ignore-scripts`,
then:

```sh
npm run test:feedback
npm run typecheck:feedback
```

The test script runs five `node:test` suites through the declared `tsx`
dependency against real temporary SQLite/FTS/vec0 stores. They are intentionally
excluded from Vitest. Typechecking follows the real imported source/type
closure; `node-llama-cpp` is a development dependency to resolve an existing
embedding type import, not a newly enabled runtime model path.

These are deterministic engineering checks, not model efficacy or production
recovery tests. Full package build/pack and ordinary CI remain separate checks.
This directory is distributed as source; no new public package subpath export
or Gateway configuration is added.

Rollback means omitting the opt-in or ceasing use of the isolated adapter.
Existing application behavior remains the caller's responsibility. Do not
delete user history or migrate a live database as a rollback operation.


The output termination correction has six new stream-boundary checks, verified
on Windows Node 24.14.0 and Linux Node 22.23.2 with targeted strict typechecks.
The two platform runs exercise the same methods. Previous full build/pack and
adapter results belong to their earlier source version. Output failure does not
undo a committed operation; retain an outer process deadline for synchronous
native blocking.
