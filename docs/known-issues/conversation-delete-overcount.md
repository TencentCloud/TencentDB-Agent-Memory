# Known issue: `/v2/conversation/delete` over-deletes in same-session multi-message cases

**Status:** open — awaiting fix

When multiple messages are written in a single `POST /v2/conversation/add` call (same `session_id`), and a subsequent `POST /v2/conversation/delete` request specifies a single ID via `message_ids: [<id>]`, the API:

1. Returns `deleted_count` greater than 1 (lying about the actual delete count vs. `message_ids.length`).
2. **Actually deletes more records than requested.** All messages in that `session_id` may be removed, not just the one specified.

Cross-session deletes (messages written to different `session_id` values) are unaffected.

## Reproduction

A standalone reproduction script is in `scripts/repro/conversation-delete-overcount.sh` of this repo. Run it against a live memory-core instance to verify.

## Code path

- Handler: `MemoryCore/src/gateway/v2-router.ts::handleConversationDelete`
- Store: `MemoryCore/src/core/store/tcvdb.ts::deleteL0`

`deleteL0` calls TCVectorDB `/document/delete` with `documentIds: [recordId]`. The upstream TCVectorDB API appears to match documents by prefix/substring rather than exact primary-key equality when given a single-element `documentIds` array.

## Suggested fix

In `deleteL0`:

1. Pre-check exact match — query for documents with `id = '<recordId>'` first; refuse to delete if the count is not exactly 1.
2. Post-verify after delete — re-query to confirm the ID is gone.
3. Refuse suspicious counts — if the upstream returns `affectedCount > 1`, treat as an error.

See the `fix/conversation-delete-overcount` branch for the proposed patch.
