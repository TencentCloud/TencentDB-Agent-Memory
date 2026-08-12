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
