# Prompt-cache verification tooling

Everything in this directory exists to verify the prompt-cache stability work.
**None of it ships** — the directory is outside the `files` whitelist in
`package.json` and is listed in `.npmignore`, so it never reaches the published
package.

| File | Kind | Purpose |
| --- | --- | --- |
| `prefix-cache-sim.ts` | model | Replays a synthetic session through `RecallCachePolicy` and scores prefix reuse. |
| `show-injected-bloat.ts` | model | Counts prompt tokens for `showInjected=false` / `true` / `true`+dedup. |
| `cache-simulation.test.ts` | test | Shape assertions over both models. Runs in the normal `npm test` suite. |
| `cache-hit-ab.mts` | live | A/B against a real OpenAI-compatible provider, reads `usage.prompt_cache_hit_tokens`. |
| `cache-granularity-probe.mts` | live | Probes a provider's cache block size and prefix-matching rule. |

Unit tests for the shipped policy itself live next to the source, at
`src/core/hooks/recall-cache-policy.test.ts`, following the repository's
co-located `*.test.ts` convention.

## Running the models

They run as part of the normal suite; no extra setup:

```bash
npm test
```

## Running the live scripts

These call a real provider and cost tokens, so they are **not** part of `npm test`.
They need an API key and are driven entirely by environment variables:

```bash
# DeepSeek (default)
DEEPSEEK_API_KEY=sk-... node node_modules/tsx/dist/cli.mjs __tests__/cache/cache-hit-ab.mts
DEEPSEEK_API_KEY=sk-... node node_modules/tsx/dist/cli.mjs __tests__/cache/cache-granularity-probe.mts

# Any other OpenAI-compatible provider
CACHE_AB_BASE_URL=https://your-endpoint/v1 \
CACHE_AB_MODEL=your-model \
CACHE_AB_KEY=sk-... \
  node node_modules/tsx/dist/cli.mjs __tests__/cache/cache-hit-ab.mts
```

A `.env` file at the repository root is picked up automatically. Both scripts
exit cleanly with a message when no key is present.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CACHE_AB_BASE_URL` | `https://api.deepseek.com` | Provider endpoint. |
| `CACHE_AB_MODEL` | `deepseek-chat` | Model id. |
| `CACHE_AB_KEY` | — | Falls back to `DEEPSEEK_API_KEY`, `API_KEY`, `OPENAI_API_KEY`. |
| `CACHE_AB_TURNS` | `20` | Turns per session. |
| `CACHE_AB_REPEATS` | `3` | Independent repeats per arm. |
| `CACHE_AB_MAX_TOKENS` | `64` | Completion cap — kept small, only the prompt side is measured. |

### Notes on measurement

Two properties of the harness matter for reproducibility:

1. **Cache isolation.** A provider's context cache survives across requests for
   a long time, so a naive A/B lets the arm that runs second reuse the first
   arm's cache. Every request is therefore prefixed with a nonce unique to the
   `(run, repeat, arm)` triple, and the arm order alternates between repeats.
2. **Steady-state reporting.** Turn 1 is a guaranteed cold miss in every arm.
   The scripts report `steadyStateHitRate` (turn 1 excluded) alongside the
   whole-session rate, since the former is what a long-running session sees.
