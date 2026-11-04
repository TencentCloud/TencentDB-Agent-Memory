# Recover historical L0 into L1

`replay-l1` addresses L0 rows left behind an already-advanced L1 cursor after
extraction failures ([#541](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/541)).
It reads the existing messages, including their original IDs and recorded times.
It never re-ingests L0 or rewinds the online pipeline checkpoint.

## Supported scope

This is a **local SQLite maintenance command** for metadata and FTS/BM25 recovery.
It does not support remote storage backends, create embeddings, update JSONL
mirrors, or trigger L2/L3 aggregation. Existing vectors and embedding settings
remain intact. Recovered memories are available to keyword/BM25 recall; pure
vector recall needs a separate embedding/reindex operation. Both the command
output and persisted receipts identify `indexMode: "fts-only"`.

Stop gateway/plugin writers and back up the data directory before applying.
`--maintenance` acknowledges that writers are stopped; it is not a distributed
lock. Concurrent invocations of **this command** are idempotent, but it cannot
coordinate with the online pipeline. Use a current, initialized SQLite database.
Normal store initialization/migrations run when applying, never during dry-run.

## Preview and apply

From a source checkout, run `npm run build:plugin` in `MemoryCore`, then use
`node bin/replay-l1.mjs`. The package also exposes the `replay-l1` executable.
Node.js >= 22.16.0 with SQLite FTS5 is required.

Every isolation dimension must be supplied explicitly. An empty task ID selects
only messages without a task; it is **not** a wildcard. Use the values stored in
the database (including `default` for legacy/default dimensions).

```bash
node bin/replay-l1.mjs \
  --data-dir "$HOME/.memory-tencentdb/memory-tdai" \
  --instance-id default --team-id team-a --user-id user-a --agent-id agent-a \
  --session-key session-retry --session-id session-a --task-id "" \
  --from 2026-07-01T00:00:00Z --to 2026-07-31T23:59:59.999Z \
  --dry-run
```

The default instance uses `<data-dir>/vectors.db`; other instances use
`<data-dir>/instances/<instance-id>/vectors.db`. Missing files, path traversal,
and symlinked instance databases are rejected. This is a trusted local operator
tool, not an authenticated admin API.

Dry-run opens the database read-only and prints selected source IDs, selected /
completed / pending row counts, and the number of pending batches. It requires
no model configuration and performs no extraction, migrations, or journal writes.
Time bounds are inclusive and compare instants, including ISO timezone offsets.
The default limit is 1,000 selected rows, including already completed rows;
`--max-rows` accepts up to 10,000. An oversized selection fails rather than
silently truncating it. Narrow the range if necessary.

Create a private configuration file for an OpenAI-compatible model:

```json
{
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "timeoutMs": 120000
}
```

Supply the key in `REPLAY_LLM_API_KEY`, or an `apiKey` field in that file. The
environment variable takes precedence. Configuration is never printed.
Repeat the preview command with `--dry-run` replaced by:

```bash
--apply --maintenance --fts-only --llm-config /private/path/replay-llm.json --mode code
```

Use `--mode chat` (the default) for personal memories, or `--mode code` for team
work memories. The command uses the existing extraction prompts. Invalid JSON,
invalid memory fields, unknown source IDs, provider errors, and storage/index
failures exit nonzero; none are treated as a successful empty extraction.
Valid empty extraction is recorded as completed.

## Retry, idempotency, and receipts

Two tables in the same database form a recovery checkpoint:

- `l1_replay_sources` reserves each source ID within its complete instance and
  tenant/session/task scope, with a hash of the selected source row.
- `l1_replay_batches` saves the input snapshot, validated model output, and final
  receipt. Batches contain at most 10 messages, ordered by recorded time and ID.

Completion advances only in the transaction that commits **all** L1 records,
FTS entries, and the receipt for that batch. A failure rolls back that batch;
earlier completed batches remain completed. If a validated model output was
already persisted, retry reuses it without another model request. If the process
dies before preparation is persisted, extraction can be called again. Concurrent
preparations use the first persisted result; the model itself is not exactly-once.

Repeat the same command after resolving a transient error. Reruns and overlapping
ranges skip completed source IDs even if batch boundaries would otherwise change.
For an incomplete batch, the requested range must contain its entire original
input snapshot; otherwise retry the original range. A changed or deleted source
cannot silently replace a reserved snapshot. Restore the original inputs from a
consistent backup before retrying; do not delete journal rows to force progress.

Within the exact scope, an existing memory with identical content, type, and
scene produces a `skip_exact` decision. Otherwise a deterministic L1 ID is stored
with `source_message_ids` and `replay_batch_id` in metadata. Semantic deduplication
and destructive merges are intentionally not performed. The receipt records each
store/skip decision and its source IDs, including lineage for an exact skip.

Successful stdout is JSON containing batch receipts with scope, source IDs,
source digest, completion time, index mode, and record decisions. Repeating a
completed selection returns the same persisted receipts without calling the model.
For overlapping selections, a receipt retains its full original batch membership.
On a failed run, completed receipts remain in `l1_replay_batches.receipt_json`;
dry-run shows how many selected rows still need recovery. Keep both journal tables
with the L0/L1 database in backups. They are durable recovery state, not disposable
logs, and contain conversation snapshots/model output subject to the same access
and retention controls as the rest of the database.

The normal online checkpoint is unchanged because moving its monotonic cursor
backward could cause unrelated sessions to be reprocessed. This command's journal
is the authoritative checkpoint for historical replay. Resume normal writers
after recovery finishes.

## Validation

```bash
npx vitest run src/core/record/l1-replay.test.ts \
  src/core/record/l1-replay-extractor.test.ts src/cli/replay-l1.test.ts
npm run build:plugin
node bin/replay-l1.mjs --help
```

Tests use real SQLite/FTS, injected SQL failures, separate CLI processes, and a
local OpenAI-compatible HTTP fixture. They cover idempotency across restarts and
overlapping ranges, equal timestamps, partial progress, malformed/provider errors,
atomic rollback, retry without a second model call, every tenant dimension,
separate instance databases, and preservation of L0, checkpoints, and vectors.
