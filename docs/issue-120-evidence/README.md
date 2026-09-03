# Issue #120 evidence

Raw probe reports behind the tables in
[`../Issue-120-实现后验证与结论.md`](../Issue-120-实现后验证与结论.md).

These are committed so the numbers can be checked, not just read. Each file is
the verbatim output of a script in
[`scripts/prompt-cache/`](../../scripts/prompt-cache/README.md) — regenerate
with the command listed below and compare.

All four files were scanned before committing: no API key, bearer token, or
provider endpoint appears in any of them.

| File | Produced by | What it shows |
| --- | --- | --- |
| `deepseek-e2e-skip-vs-reminder.json` | `e2e-quality-cache-compare.mjs` | DeepSeek v4-flash, 3-turn release-brief task under `showInjected_risk` / `ABC_skip` / `ABC_reminder`, with per-scenario grading and cache usage. `skip` has the best cache numbers and returns empty content; `reminder` passes. |
| `mimo-e2e-skip-vs-reminder.json` | `e2e-quality-cache-compare.mjs` | Same task on MiMo v2.5-pro. `skip` fails grading by returning `ready` as prose instead of a boolean. |
| `mimo-showinjected-growth-10turns.json` | `show-injected-growth-probe.mjs` | Per-turn prompt tokens across 10 turns with recall frozen into history, for the growth curve. |
| `session-prompt-dedupe-probe.json` | `session-prompt-dedupe-probe.mjs` | `重复追加` vs `去重追加` for the stable system block. |

## Reproducing

```bash
export DEEPSEEK_API_KEY=...   # and/or MIMO_API_KEY
node scripts/prompt-cache/e2e-quality-cache-compare.mjs
node scripts/prompt-cache/show-injected-growth-probe.mjs
node scripts/prompt-cache/session-prompt-dedupe-probe.mjs
```

Reports land in `tmp/issue120-e2e-results/` (git-ignored). Token counts will
not match these files exactly: provider cache state, model minor versions and
tokenizer updates all move the numbers. What should reproduce is the
*ordering* — `skip` cheapest on cache metrics, `reminder` the cheapest option
that still passes grading, and the risk baseline growing without bound.

`--regrade <report.json>` re-scores a report without re-issuing requests.
