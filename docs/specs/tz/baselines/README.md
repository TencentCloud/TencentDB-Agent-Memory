# tz-04 — recall baselines

Aggregate measurements only. The corpus they were taken on is derived from
personal memory and **never** enters this repository — the baseline carries
`corpusHash` instead, so two numbers can be compared only when the questions
behind them were the same.

Reproduce (read-only, on a COPY of the store):

```sh
cp ~/.pi/agent-memory/tdai/vectors.db /tmp/probe/vectors.db
npx tsx scripts/tz04-corpus/build-corpus.mts \
  --db /tmp/probe/vectors.db --out /tmp/probe/probe-corpus.json
set -a; . ~/.config/tdai/embedding.env; set +a   # bash; the key is never in the repo
npx tsx scripts/tdai-recall-probe.mts \
  --db /tmp/probe/vectors.db --corpus probe-corpus.json --top-k 10 \
  --compare docs/specs/tz/baselines/tz-04-recall-baseline.json
```

Expected output: the six strata with their pair counts, the aggregate, and a
per-metric delta against the baseline.

`tz-04-recall-baseline.json` — taken 2026-08-13 on 120 pairs (20 per stratum,
50% of the queries are the owner's own wording from L0), BEFORE any scoring
change in this package. `precision@k` is bounded by `|expected| / k` — every
pair has exactly one right answer, so 0.2 is the ceiling at @5 and 0.1 at @10.
`recall@k` is the number to read.

`tz-04-recall-tuned.json` — the same corpus after the Ф6 change, at the settings
the sweep picked. Both files carry the same `corpusHash`, so they are
comparable.

## What the sweep found (2026-08-13, same corpus, R@10)

| strategy | threshold | R@10 |
|---|---|---|
| embedding | 0 / 0.1 / 0.2 | 0.708 / 0.708 / 0.700 |
| embedding | 0.3 | 0.592 |
| hybrid | 0 (≡ pre-fix behaviour) | 0.700 |
| hybrid | 0.2 / **0.6** / 0.7 / 0.8 | 0.717 / **0.767** / 0.767 / 0.758 |

Before the Ф6 fix `hybrid` ignored the threshold entirely, so that whole column
was one number. The default strategy could not be tuned at all.

`defaultCrossProjectMultiplier` (hybrid, threshold 0.6), mean R@10 over strata:

| multiplier | own | foreign |
|---|---|---|
| 1.0 (decay effectively off) | 0.750 | 0.750 |
| 0.5 (current default) | 0.817 | 0.717 |
| **0.3** / 0.1 (identical — the ranking is already fully separated) | **0.817** | **0.650** |

**Recommendation for `tdai-gateway.yaml`** (not applied — the live config is the
owner's): `recall.strategy: hybrid`, `recall.scoreThreshold: 0.6`,
`recall.defaultCrossProjectMultiplier: 0.3`. Against the live
`embedding`/`0.2`/`0.5` this is own-project R@10 0.750 → 0.817 with foreign
R@10 unchanged at 0.650 — the gain is in the project that asked, not in
leakage.

The code defaults stay as they are: `scoreThreshold` is shared by all
strategies, and 0.6 is right for `hybrid` cosine candidates but destroys
`embedding` (0.3 already costs 11 pp there). A per-strategy default is a
separate change with its own measurement.
