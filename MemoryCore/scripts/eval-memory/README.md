# eval-memory — reproducible memory evaluation

A self-contained, opt-in harness that measures memory quality of the **standalone Gateway** end to end, so benchmark results can be reproduced and compared outside the team (issues [#106](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/106), [#73](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/73)).

[中文文档](./README_CN.md)

## What it does

For each conversation in a benchmark dataset:

1. **Ingest** — replays every round through `POST /capture`, flushing each session with `POST /session/end`.
2. **Settle** — waits for the L1/L2/L3 pipeline to drain by polling `POST /v2/pipeline/status` (queue-based, with a stability window so short L2/L3 cascade timers are not mistaken for completion).
3. **Answer** — for each benchmark question, calls `POST /recall` and has an answerer LLM answer **from the recalled context only**. Optionally a no-memory baseline answers from the raw transcript.
4. **Judge** — an LLM judge grades each answer against the gold answer (lenient on wording, strict on facts). Unparseable verdicts count as wrong, so a flaky judge can only under-report accuracy.
5. **Report** — writes `report.json` + `report.md` with per-category accuracy, context-token costs, pipeline stats, and the full run-metadata block (commit, models, dataset, resolved Gateway config) needed to compare independent runs.

By default each conversation gets its **own spawned Gateway process with a fresh data directory**, so memories can never leak between conversations. The generated per-conversation Gateway config is kept in the output directory as part of the run record.

The pipeline design (ingest → search → judge) follows [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) (Apache-2.0).

## Requirements

- Node.js ≥ 22.16.0, `npm install` done in `MemoryCore/`
- An OpenAI-compatible LLM endpoint (used for the Gateway's L1/L2/L3 extraction **and** for the answerer/judge)

No new dependencies: the harness reuses `ai`, `@ai-sdk/openai`, `js-tiktoken`, and `tsx`, which MemoryCore already declares. Nothing here is included in the published npm package, and nothing runs in CI.

## Quick start

```bash
cd MemoryCore

export TDAI_LLM_BASE_URL="https://api.openai.com/v1"
export TDAI_LLM_API_KEY="sk-..."
export TDAI_LLM_MODEL="gpt-4o-mini"

# 1. Wiring check with the tiny built-in dataset (~1 minute, a few LLM calls)
npm run eval:memory -- --dataset synthetic

# 2. Inspect what a LoCoMo run would do — no Gateway, no LLM calls
npm run eval:memory -- --dataset locomo --dry-run

# 3. Small LoCoMo slice (2 conversations × 20 questions)
npm run eval:memory -- --dataset locomo --max-conversations 2 --max-questions 20

# 4. Full LoCoMo with a full-context baseline comparison
npm run eval:memory -- --dataset locomo --baseline full-context
```

Results land in `scripts/eval-memory/results/<timestamp>/` (git-ignored).

## Datasets

| Adapter | Contents | Source |
| --- | --- | --- |
| `synthetic` | 1 conversation, 2 sessions, 4 questions — a deterministic wiring check, **not** a quality benchmark | built in |
| `locomo` | [LoCoMo](https://github.com/snap-research/locomo) (Maharana et al., ACL 2024): 10 multi-session conversations, ~1,500 judged questions (single-hop / multi-hop / temporal / open-domain) | downloaded from the official repo at run time |

The LoCoMo dataset is **CC BY-NC 4.0** and is deliberately **not vendored** into this repository — the harness fetches it from the official source (or `--locomo-path` for an existing local copy). Use it for non-commercial evaluation in line with its license. Adversarial questions (category 5) are excluded by default, matching common practice ([mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)); include them with `--include-adversarial`.

LoCoMo dialogs are between two named humans; the adapter maps `speaker_a` → user and `speaker_b` → assistant, keeps every line prefixed with the real speaker name, and anchors each session's in-universe date into the first round (L0 capture timestamps are "now", so temporal questions must be answerable from content).

Adding a benchmark (e.g. PersonaMem, or corpus-driven test databases) means adding one adapter in `datasets.ts` that emits the normalized `EvalDataset` shape — the runner is dataset-agnostic.

## Options

Run `npm run eval:memory -- --help` for the full list. The important ones:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dataset` | `synthetic` | `synthetic` or `locomo` |
| `--max-conversations` / `--max-questions` | 0 (all) | slice for cheap runs |
| `--baseline` | `none` | `full-context` adds a no-memory comparison answering from the (tail-truncated) transcript |
| `--gateway-url` | — | reuse an already-running Gateway instead of spawning; the caller owns data isolation |
| `--port` | 8437 | port for spawned Gateways |
| `--settle-timeout-s` | 600 | max pipeline-drain wait per conversation |
| `--dry-run` | — | parse the dataset, print the plan, exit |

Answerer / judge models default to `TDAI_LLM_MODEL`; override with `TDAI_EVAL_ANSWER_MODEL` / `TDAI_EVAL_JUDGE_MODEL`. Judging with a stronger model than the answerer is a common and cheap accuracy upgrade.

## Reading the report

`report.md` contains:

- **Run metadata** — commit, node/platform, dataset + source, all three model roles, gateway mode, flags. Two reports are comparable iff these match (or the difference is the thing you are measuring).
- **Accuracy** — per category and overall; with `--baseline full-context`, side-by-side memory vs. baseline accuracy and average context tokens (the memory-vs-raw-context token cost is usually the headline trade-off).
- **Pipeline stats** — rounds ingested, L1 records extracted, settle time, and whether the pipeline fully drained (`settled=no` runs are still reported but should be treated as suspect).
- **Sample failures** — the first 20 wrong answers with judge reasons, for quick error analysis.

`report.json` has the full per-question detail (recall strategy, memory counts, recall error codes, latencies) for downstream analysis.

## Caveats

- Scores depend on the extraction/answer/judge models; only compare runs with matching metadata blocks.
- The evaluation-tuned Gateway config shortens pipeline timers (`l2DelayAfterL1Seconds: 3` etc.) so runs settle in seconds; production defaults would behave identically given enough idle time, but timing-sensitive behaviours are not what this harness measures.
- `--gateway-url` mode shares one memory store across all conversations in the dataset; recall can cross-contaminate. Prefer the default spawned mode for scoring.
- LLM-as-judge is imperfect; spot-check `report.json` before quoting numbers.
