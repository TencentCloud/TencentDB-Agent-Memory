# Optional feedback-driven policy optimization

`from tencentdb_agent_memory.feedback import FeedbackOptimizer, PolicySnapshot`
adds an explicit, provider-neutral adaptation session to the Python SDK. It is
**off by default**. Existing `MemoryClient` / `AsyncMemoryClient` imports and
requests are unchanged. The optimizer itself uses only the standard library;
it makes no network calls, opens no files and owns no database.

Use it to turn a reviewed memory mistake into one bounded prompt-rule hypothesis,
then compare that hypothesis in an isolated replay before adopting it. It is not
model training, automatic ground-truth inference or a production write endpoint.
See the [design and architecture](../../../../docs/design/feedback-self-optimization.md)
and the [runnable SQLite example](../../../../examples/feedback-selfopt/README.md).

## Run the public example

From a checkout containing this change:

```sh
python -m pip install ./sdk/memory-core/python
python -B sdk/memory-core/python/examples/feedback_optimizer.py --fixture
```

This example uses invented measurement tables and a scripted proposal, makes zero
provider requests, exercises adoption and rollback, and asserts no efficacy.
The SQLite companion demonstrates actual store/receipt measurements. Neither
example requires provider keys or an external evolution framework.

## Lifecycle and host integration

| Method | Result / responsibility |
|---|---|
| Constructor | `enabled=False`; configure a fixed `interface_id`, 1–8 trusted annotation source IDs, and excluded training literals |
| `prepare(batch)` | Validate bindings; select one current verified policy error plus correct write and NOOP controls; return a detached packet |
| `generation_request(classifier_system)` | Build at most one provider-neutral request containing the exact frozen classifier; no request is sent |
| `submit_response(packet_sha256, raw_response)` | Accept one bounded patch and stage an **inactive** `PolicySnapshot` |
| `evaluate(comparison)` | Compare complete paired training observations, with immutable annotations and plans; adopt only if all gates pass |
| `cancel(reason)` | Stop on `transport_failure`, `evidence_failure` or `study_stopped`; keep the starting policy |
| `rollback(reason)` | Restore the starting policy after adoption (`regression`, `operator_request`, `load_failure`) |
| `disable()` | Disable this instance and restore its starting policy |
| `audit()` | Detached bounded events, codes, counts and hashes; no source/rule/answer text |

An application supplies four things: its authenticated and reviewed feedback,
the frozen common classifier, a bounded provider call, and two isolated replay
results measured with the same labels and model configuration. The application
passes only `candidate.rules` into the candidate replay; it does not change its
serving policy until `evaluate` adopts and a separate deployment decision allows
it. A successful training gate is not an independent generalization result.

The generation call must have an application deadline, an explicit send/token
budget and zero automatic retries/fallback. On a failed or uncertain call,
`cancel("transport_failure")` consumes the opportunity. Do not replay a possibly
committed memory mutation. A rejected hypothesis leaves the existing policy
active. Policy rollback does **not** undo previously committed user memories.

## Feedback contract

`FEEDBACK_SCHEMA = "source-bound-single-feedback-v1"`;
`MECHANISM = "verified_single_root_exploration_v1"`.
Every dictionary has exact fields; bool values cannot stand in for integers.

The top-level fields are `schema`, `policy_sha256`, `interface_id`, `split`
(exactly `train`), `planned`, and `rows`. `planned` contains unique
`[dialogue, turn, repeat]` coordinates. Turns start at 1 and are contiguous within
each dialogue/repeat; repeats of a dialogue must cover the same turn schedule.
Every planned coordinate requires a row, including unobserved failures.

Each row has these fields:

| Field | Contract |
|---|---|
| `dialogue`, `lineage`, `root`, `turn`, `repeat` | Stable sample and causal-root identity; propagated downstream failures reuse the original root |
| `origin` | `current`, `propagated`, or `none` |
| `authority`, `authority_kind` | Allowlisted host identity; kind is `human` or `controlled_author` |
| `annotation_sha256`, `source_sha256`, `trace_sha256` | Reviewed label, exact UTF-8 `text`, and actual trace bindings; observed rows require a trace digest |
| `text`, `expected`, `predicted` | Original current source; reviewed expected dictionary; predicted dictionary or null |
| `observed`, `probe`, `action` | Strict booleans; action is `add`, `update`, `retire`, or `noop` |
| `cause`, `family` | Host-reviewed attribution; family is null or a supported policy error family |
| `checks` | Exactly `state`, `commit`, `use`, each true/false/null; `use` is null off-probe |
| `risks` | Exactly `wrong_add`, `wrong_change`, `target_mismatch`, `unauthorized_persistence`, `stale_active`, each true/false/null |
| `cost` | Exactly `tokens` (nonnegative int/null) and `latency_ms` (finite nonnegative number/null) |

Causes are `none`, `policy_semantic`, `policy_content`, `interface`, `execution`,
`retrieval`, `answer`, `infrastructure`, or `integrity`. Supported policy families:
`durable_change_missed`, `temporary_or_third_party_persisted`,
`memory_vs_answer_object_confused`, `scope_or_target_confused`,
`wrong_source_fact_selected`, and `obsolete_state_not_replaced_or_retired`.

The host must derive **state** from actual active records and reviewed source
meanings, **commit** from actual mutations and target/version evidence, and
**use** from the content actually delivered to an answer consumer and its reply.
An acknowledgement in an assistant reply is not a commit. An injected receipt
alone is not proof of provider delivery. Unknown semantic ranges stay unknown;
copying extra neutral context is not automatically an incorrect fact or unsafe
persistence. The short fixture deliberately uses an exact authored vocabulary.
It is not a semantic evaluator for arbitrary conversations.

Hashes bind bytes and detect changes; they do not authenticate a caller or prove
that annotations and measurements are true. The application must verify those
facts outside this module. Model confidence, model-generated labels, thanks and
silence are not verification authorities.

## Exploration versus adoption

A single **current** policy error with known failed state and commit can request
one candidate, provided correct write and NOOP controls exist. Interface errors,
unknowns and propagated errors do not become new policy evidence. An integrity
failure blocks exploration. Partial evidence can permit a hypothesis, but cannot
permit adoption.

Adoption requires identical plans and annotations, all actual measurements and
costs known, every observed occurrence of the selected root fixed, no previously
correct state/commit/probe regressed, no new risk and no dialogue regressed.
Mean fact-state accuracy must improve by at least **5 percentage points** using
equal dialogue weights, equal repeat weights within each dialogue and equal
turn weights within a repeat. Candidate replay tokens must be at most **1.25x**
and p95 replay latency at most **1.5x** the baseline (nearest-rank p95).
Generation cost is separate and must also be reported by the host. Missing
observations/costs reject adoption, not disappear from the denominator.

The response is one JSON object with exactly `family`, `support`, `patch`.
`support` is exactly one `[dialogue, turn, repeat, root]` array copied from the
packet. `patch` has `op` (`add`/`replace`/`remove`), `rule_id` (`R1`–`R8`), and
`text` (null only for removal). One exact JSON fence is recognized; duplicate
keys, prose, repaired fields, object-to-array conversions and changed coordinates
are rejected. Excluded literals use NFKC/casefold matching. This filter is only
a bounded copying guard, not a complete privacy or prompt-injection defense.

## Limits and compatibility

| Resource | Limit |
|---|---:|
| Feedback batch | 256 KiB, 128 planned rows, 32 dialogue/repeat branches |
| Repeats / turns | 1–3 / 1–128 |
| Source / expected / predicted per row | 8 KiB / 2 KiB / 2 KiB |
| Generator request including fixed instruction | 32 KiB |
| Generator response | 8 KiB |
| Rules / per rule / combined rule text | 8 / 512 UTF-8 bytes / 2 KiB |
| Policy version / proposals per session | 0–3 / 1 |
| Excluded literals / bytes per literal | 128 / 128 |
| Audit events / concurrent update | 8 / 1 (overlap rejected) |

Selection/comparison are linear in bounded rows, with p95 sorting in O(n log n);
space is O(n) including detached copies. No unbounded cache or hidden background
loop exists. SDK runtime supports Python 3.9+; the source SQLite example requires
Python 3.11+ and Node 22.16+. Types ship with the optional package. CI checks the
public API on Python 3.9/3.13 and the real SQLite connection on Python 3.11.

This is an optional source/SDK extension. It does not register a Gateway API,
change default extraction, support other storage backends for atomic writes, or
claim production authorization. The TypeScript observer is shadow-only;
existing writes remain authoritative. See each adapter's README for its exact
scope and limits.
