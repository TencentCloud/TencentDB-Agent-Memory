# Prompt cache probes (issue #120)

Measurement harness behind the numbers reported in
[`docs/Issue-120-实现后验证与结论.md`](../../docs/Issue-120-实现后验证与结论.md).

These scripts are **not** part of the plugin runtime. Nothing under `src/` or
`index.ts` imports them, and the plugin never runs them. They exist so the
cache claims in the issue-120 docs can be re-derived rather than taken on
trust.

## Credentials

Every script reads credentials from the environment only. No key, endpoint, or
organisation identifier is committed, and none is written to a report file.

| Variable | Used by | Default |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | e2e compare, session dedupe | *(required for DeepSeek runs)* |
| `DEEPSEEK_BASE_URL` | e2e compare, session dedupe | `https://api.deepseek.com/v1` |
| `DEEPSEEK_MODEL` | e2e compare, session dedupe | `deepseek-v4-pro` |
| `MIMO_API_KEY` | growth probe, session dedupe | *(required for MiMo runs)* |
| `MIMO_BASE_URL` | growth probe, session dedupe | `https://api.xiaomimimo.com/v1` |
| `MIMO_MODEL` | growth probe, session dedupe | `mimo-v2.5-pro` |

A provider with no key set is skipped rather than failing the run. Every
script accepts `--dry-run`, which builds and reports the exact request bodies
without contacting a provider — use it to review what would be sent before
spending tokens.

Reports are written to `PROBE_OUT_DIR` / `E2E_OUT_DIR`, which default to a
git-ignored directory. Copy a report into `docs/issue-120-evidence/` only
after checking it carries no credentials.

## Scripts

### `e2e-quality-cache-compare.mjs`

The one that decides which mitigation ships. Runs the same multi-turn
release-brief task under `showInjected_risk`, `ABC_skip` and `ABC_reminder`,
grades the final JSON against a fixed answer key, and reports cache usage per
scenario.

Cache metrics alone rank `skip` first. Grading it is what exposes that `skip`
drops facts the task needs — on DeepSeek it produced empty output, on MiMo it
returned `ready` as prose instead of a boolean — so `reminder` ships instead.
Any change to recall trimming should be re-run through this script before the
token numbers are believed.

```bash
E2E_PROVIDERS=deepseek,mimo node scripts/prompt-cache/e2e-quality-cache-compare.mjs
node scripts/prompt-cache/e2e-quality-cache-compare.mjs --dry-run
node scripts/prompt-cache/e2e-quality-cache-compare.mjs --regrade <report.json>
```

`--regrade` re-scores an existing report without re-issuing requests, so a
grading-rule change does not cost another paid run.

Knobs: `E2E_TURNS` (default 3), `E2E_MAX_OUTPUT_TOKENS` (default 400),
`E2E_DELAY_MS`, `E2E_REQUEST_TIMEOUT_MS`.

> On models that spend the output budget on reasoning tokens, a low
> `E2E_MAX_OUTPUT_TOKENS` can yield empty content and look like a task
> failure. MiMo runs in the docs use 2400.

### `show-injected-growth-probe.mjs`

Measures conversation-history growth with `showInjected=true`: a stable system
prefix, then a fresh recall block frozen into history on every turn. Produces
the per-turn prompt-token curve used to show the growth is quadratic in turn
count, not linear.

```bash
PROBE_TURNS=10 node scripts/prompt-cache/show-injected-growth-probe.mjs
```

### `session-prompt-dedupe-probe.mjs`

Compares `重复追加` (the same stable system block re-appended every turn)
against `去重追加` (appended once). Isolates the cost of duplicated stable
content from the cost of dynamic recall.

```bash
PROBE_PROVIDERS=deepseek,mimo node scripts/prompt-cache/session-prompt-dedupe-probe.mjs
```

## Reading the numbers

Compare `cache_hit_ratio`, `cache_miss_tokens` and total `prompt_tokens`
together. Ratio on its own is misleading here: the `showInjected` baseline
scores a *high* hit ratio precisely because it replays the same large stale
recall blocks every turn, while its total input and context-window usage grow
without bound. A mitigation that lowers total tokens can therefore show a
lower ratio and still be the better outcome.

Providers also differ in what they report. DeepSeek returns
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` directly; MiMo reports
`prompt_tokens_details.cached_tokens`. The scripts read the real fields where
available and only derive misses by subtraction as a fallback, so a missing
field is never silently reported as zero hits.
