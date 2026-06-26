# Reproducible Memory Evaluation Guide

This guide defines a lightweight record format for memory benchmark runs. It is
framework-neutral: use it with public benchmarks, internal long-horizon tasks,
or generated memory test databases.

## Goals

A useful TencentDB Agent Memory evaluation should report more than final task
accuracy. Record enough context to answer:

- Did the system store the right evidence in L0?
- Did L1 extract atomic, current, and correctly typed memories?
- Did L2/L3 summarize the right scenes and persona traits?
- Did recall inject the right layer at the right time without excessive tokens?
- Did token savings or recall gains come from memory behavior rather than a
  changed model, prompt, dataset split, or session layout?

## Run Metadata

Capture these fields for each run:

| Field | Example |
| :--- | :--- |
| Git commit | `a21ef3f` |
| Package version | `0.3.6` |
| Host | `OpenClaw 2026.6.x` / `Hermes` |
| Node.js | `v24.15.0` |
| Main model | provider and model id |
| Extraction model | provider and model id, if different |
| Embedding config | provider, model, dimensions, BM25 on/off |
| Store backend | `sqlite` / `tcvdb` |
| Recall config | strategy, `maxResults`, score threshold, budgets |
| Dataset | benchmark name, split, seed, task count |
| Session layout | isolated turns, multi-turn sessions, or N tasks per session |

Keep the resolved plugin config with secrets redacted. Small config changes can
materially affect recall behavior.

## Dataset And Session Design

Use a session design that matches the claim being tested:

- **Short-term offload**: run long tool-heavy tasks in continuous sessions and
  measure token use, compression ratio, and task success.
- **Long-term personalization**: seed multiple sessions, allow L1/L2/L3
  generation to complete, then ask held-out queries.
- **Layer stress tests**: include queries that should be answered from different
  layers: exact L0 evidence, L1 atomic facts, L2 scene summaries, and L3 persona.
- **Temporal drift tests**: include stale facts, updates, and superseding events
  to check whether recall mixes old and current state.

Avoid reporting only isolated one-turn results when the feature under test is
designed for long-horizon sessions.

## Layer Checks

Record representative artifacts for a small audited subset:

| Layer | What to inspect |
| :--- | :--- |
| L0 Conversation | Raw messages are present, scoped to the right session, and free of injected recall tags. |
| L1 Atom | Extracted memories are atomic, typed correctly, current, and not overlong incident summaries. |
| L2 Scenario | Scene blocks group related memories without losing important qualifiers. |
| L3 Persona | Persona claims are stable preferences, not one-off task instructions. |
| Recall | Injected context is relevant, bounded, and points to deeper search when snippets are insufficient. |

For failed answers, attach the recalled L1 snippets, scene navigation, persona
excerpt, and source L0 messages when possible.

## Metrics

Recommended metrics:

- Task success or answer accuracy.
- Total input/output tokens and relative token change.
- Recall precision: fraction of injected memories that support the answer.
- Recall miss rate: queries where supporting memory exists but was not recalled.
- Layer attribution: L0, L1, L2, or L3 source used for each correct answer.
- Context budget usage: injected L1 count, injected characters/tokens, and drops
  caused by configured recall budgets.
- Latency for recall, capture, L1 extraction, L2 scene generation, and L3 persona
  generation.

When using an external benchmark framework, map its native metrics onto these
fields instead of replacing them.

## Result Template

```md
## Evaluation Summary

- Commit:
- Host / model:
- Dataset / split:
- Session layout:
- Tasks / queries:
- Config file:

| Metric | Baseline | TencentDB Agent Memory | Delta |
| :--- | ---: | ---: | ---: |
| Success / accuracy | | | |
| Input tokens | | | |
| Output tokens | | | |
| Recall precision | | | |
| Recall miss rate | | | |
| Median recall latency | | | |

## Layer Audit

- L0 evidence quality:
- L1 atom quality:
- L2 scene quality:
- L3 persona quality:
- Recall relevance and budget behavior:

## Known Limitations

- Dataset coverage:
- Model variance:
- Manual audit sample size:
- Uncontrolled environment differences:
```

## Notes For Future Integrations

Benchmark runners should be additive and optional. Prefer a small adapter that:

- loads or seeds conversations through public capture/seed paths,
- waits for configured L1/L2/L3 processing when the benchmark needs long-term
  memory,
- stores run metadata and resolved config next to results,
- redacts secrets from exported artifacts,
- keeps benchmark dependencies out of the runtime package unless explicitly
  required.
