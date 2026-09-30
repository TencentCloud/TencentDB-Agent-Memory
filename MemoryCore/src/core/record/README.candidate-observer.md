# Optional L1 candidate observer

`extractL1Memories` accepts `options.candidateObserver` for bounded local
observation immediately before its existing writer. The default is off. It
does not change extraction prompts, dedup decisions, memory contents or write
authorization, and has no connection to the isolated feedback chain.

```ts
candidateObserver: {
  mode: "shadow",
  timeoutMs: 100,
  observer(snapshot, signal) {
    if (signal.aborted) return [];
    return snapshot.candidates.map(candidate => ({
      candidate_id: candidate.record_id,
      disposition: "baseline",
      reason: "unchanged",
      confidence: null,
    }));
  },
}
```

Omitting the option/mode, or choosing `off`, prevents input copying, callback
execution and new observation logging. Shadow mode receives detached, deeply
frozen copies of actual candidates, effective dedup decisions and the existing
background/current message windows. A missing source ID invalidates observation
without changing the writer. Dedup, dedup fallback and disabled dedup each
observe at most once; empty extraction retains its original early return.

`baseline`, `defer` and `reject` are observations only: none blocks, edits or
deletes a memory. Output must align exactly one-to-one with candidates and use
the fixed schema. The callback receives no store, writer, model runner,
authenticated domain, version or delivery receipt. Confidence is uncalibrated
and conveys no execution authority.

Bounds are exported as `CANDIDATE_OBSERVER_LIMITS`: 32 candidates, 64 source
messages/raw decisions, 16 targets per decision, 64 source IDs per candidate,
8 KiB per string, 64 KiB copied text, 4096 copied nodes and depth 8. Oversized,
cyclic, accessor-backed or unsupported objects reject without truncation.
Work is linear in accepted bounded input/output size, with no persistent cache.

Use trusted nonblocking local callbacks. One callback may have one outstanding
task, and four tasks may exist globally. The 1–1000 ms deadline aborts a signal
and ignores late output; it cannot preempt synchronous JavaScript or force an
asynchronous callback to settle. A timed-out callback holds its slot until it
settles, possibly indefinitely. This is not a sandbox and cannot restrict
authority captured by a trusted callback elsewhere. No network callback,
provider calls, retry policy or self-optimization algorithm is supplied.

One bounded aggregate audit event reports mode, fixed reason/path, counts and
elapsed time, with `baseline_preserved: true` and `write_authorized: false`.
It omits content, IDs, targets, exception text and arbitrary callback output.
Logging failure does not divert the writer. These events describe observation,
not commit success or exact record-level alignment. Snapshot contents and the
private return value must not be copied into public logs without review.

From `MemoryCore` after the normal dependency installation:

```sh
npm run test:candidate-observer
npm run typecheck:candidate-observer
```

Vitest covers the module and the actual extractor hook with mocked original
runner/dedup/writer dependencies. It checks writer argument equality, call
counts, all three routes, off, failure, timeout, capacity and the once guard.
The strict typecheck covers the new module and unit tests against real imported
upstream types; it is not a whole-extractor or project typecheck. Full package
CI, unmocked production persistence/recovery and model effect quality are
separate validation requirements.

Rollback by removing the option or setting `mode: "off"`. There is no observer
database migration or alternate writer to undo. This is an internal source API;
no public package export or Gateway setting is introduced.
