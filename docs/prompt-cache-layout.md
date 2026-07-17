# Prompt-cache behavior of memory recall

This note documents the complete TencentDB-specific scope of [Issue #120](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120).
The reporter later confirmed that the observed 29% webchat collapse came from an OpenClaw regression rather than this plugin. The changes below therefore target independently reproducible prompt-shape and history-growth problems without claiming to fix that host regression.

## Context structure

OpenClaw composes hook-provided context in this order:

```text
prependSystemContext + baseSystemPrompt + appendSystemContext
prependContext + currentUserPrompt + appendContext
```

Before this change, stable memory context was placed after the host's volatile system-prompt tail, while dynamic recall could only be prepended to the user prompt:

```text
System prompt (before)
├─ OpenClaw stable sections                         reusable
├─ CACHE_BOUNDARY
├─ volatile runtime/session sections                changes between turns
└─ appendSystemContext
   ├─ user persona                                  stable, behind volatility
   ├─ scene navigation                              semi-stable, behind volatility
   └─ memory tools guide                            static, behind volatility

Current user prompt
├─ prependContext: <relevant-memories>              dynamic per query
└─ original user text                               dynamic per turn

Persisted history
└─ behavior was implicit: injected blocks were always removed
```

After this change:

```text
System prompt (all modes)
├─ prependSystemContext
│  ├─ user persona                                  stable and reusable
│  ├─ scene navigation                              reusable until L2 changes
│  └─ memory tools guide                            static and reusable
├─ OpenClaw stable sections                         reusable
├─ CACHE_BOUNDARY
└─ volatile runtime/session sections                changes between turns

Current user prompt (recall.injectionMode="prepend", default)
├─ prependContext: <relevant-memories>              dynamic per query
└─ original user text

Current user prompt (recall.injectionMode="append", opt-in)
├─ original user text
└─ appendContext: <relevant-memories>               dynamic per query

Persisted history (recall.showInjected=false, default)
└─ original user text                               injected block is stripped
```

`appendContext` became part of the OpenClaw prompt-hook contract in v2026.4.27. The plugin checks `api.runtime.version` and falls back to `prepend` when append support is old or cannot be established. Stable system-context fields are left intact by this shaping step. The Gateway/Hermes response joins both stable system-context fields, so persona and scene content remain available outside OpenClaw.

## Runtime controls

| Setting | Default | Effect |
|---|---|---|
| `recall.injectionMode="prepend"` | yes | Backward-compatible placement before the current user text |
| `recall.injectionMode="append"` | no | Places dynamic L1 recall after the current user text on OpenClaw v2026.4.27+ |
| `recall.showInjected=false` | yes | Removes `<relevant-memories>` before the user message is persisted |
| `recall.showInjected=true` | no | Preserves injected markup for debugging; this intentionally increases future request size |

The append mode is opt-in because changing the order of model-visible text can affect instruction interpretation. History cleanup remains the default in both modes.

## `showInjected` growth model

If a dynamic recall block of `R` tokens is persisted on every turn, the final request carries approximately `R × (N - 1)` stale recall tokens after `N` turns. Aggregate replay across the session grows quadratically:

```text
aggregate replay = R × N × (N - 1) / 2
```

For the issue's reported 500–1,700 tokens per recall and a 100-turn session:

| Measure | 500 tokens/turn | 1,700 tokens/turn |
|---|---:|---:|
| Extra recall in the final request | 49,500 | 168,300 |
| Aggregate recall replay | 2,475,000 | 8,415,000 |

The default `showInjected=false` makes persisted growth from recall zero. The multipart cleanup path edits only text parts and preserves images or other structured content. `showInjected=true` is retained as an explicit debugging option rather than an accidental behavior.

## Session-level deduplication

Suppressing a stable system block merely because it was returned on a previous turn is not safe: hook output is request-scoped, and omitting it removes persona/scene guidance from the next model request. Likewise, skipping a repeated L1 memory while `showInjected=false` would make that memory invisible to the current turn.

The safe equivalent of session deduplication is therefore:

1. keep stable content byte-identical and before volatile host content so the provider can reuse its prefix;
2. keep dynamic L1 recall request-scoped;
3. remove dynamic recall before persistence so it is not replayed by history;
4. invalidate the reusable prefix naturally when persona or scene content actually changes.

This avoids per-session invalidation state for topic changes, memory writes, restarts, and parallel turns while preserving model-visible information.

## Provider comparison and live measurement

DeepSeek enables disk context caching automatically. Its current documentation describes complete persisted prefix units and exposes `prompt_cache_hit_tokens` plus `prompt_cache_miss_tokens`. A matching earlier request can be reused, but caching remains best-effort.

MiMo also bills matching request prefixes as Prompt Cache hits and distinguishes hit and miss prices. Its OpenAI-compatible API may expose cache detail differently by endpoint/model; the published chat example currently shows `prompt_tokens_details: null`. The plugin therefore does not invent MiMo hit counts when the host supplies none.

On OpenClaw versions exposing `llm_output` usage, enabling `report.enabled` emits a `prompt_cache_usage` metric for each model call with:

```text
provider, model
uncachedInputTokens
cacheReadTokens
cacheWriteTokens
cacheMissTokens = uncachedInputTokens + cacheWriteTokens
promptTokens = cacheMissTokens + cacheReadTokens
cacheHitRate = cacheReadTokens / promptTokens
```

OpenClaw normalizes provider-specific responses into `input`, `cacheRead`, and `cacheWrite`; the plugin emits a sample only when at least one numeric field exists. This makes DeepSeek/MiMo comparisons observable without parsing provider-specific response JSON in the memory plugin.

## Verification strategy

The automated tests cover three independent claims:

1. **Stable prefix placement:** two turns use the same persona/tools block of more than 4,000 characters and different volatile host tails. Moving the block to `prependSystemContext` increases the deterministic common-prefix span by exactly the stable block length plus its separator.
2. **Dynamic injection and history:** append mode moves only L1 recall, old/unknown hosts fall back to prepend, and five persisted turns with cleanup contain no injected markup.
3. **Provider accounting:** DeepSeek and MiMo-shaped normalized usage fixtures verify hit/miss/write arithmetic and reject missing or malformed usage rather than reporting fabricated rates.

Deterministic prefix length proves placement, not a production cache-hit percentage. A controlled provider A/B should use the same model, channel, tool schemas, session seed, and prompt sequence:

```text
Variant A: recall.injectionMode="prepend", recall.showInjected=false
Variant B: recall.injectionMode="append",  recall.showInjected=false
```

Exclude the cold first request, repeat each variant several times, aggregate `prompt_cache_usage` by provider/model, and report tool-call counts because different tool paths alter the prefix independently. Run the comparison on OpenClaw v2026.4.27 or newer so both variants are actually distinct.

For a direct provider A/B without modifying an OpenClaw installation, the repository includes a controlled runner. It sends three or more requests per variant, changes the volatile host tail and recalled L1 block each turn, excludes the cold first request, and prints only usage statistics (never the API key or response text):

```bash
PROMPT_CACHE_BENCH_BASE_URL="https://api.deepseek.com/v1" \
PROMPT_CACHE_BENCH_API_KEY="..." \
PROMPT_CACHE_BENCH_MODEL="deepseek-chat" \
npm run benchmark:prompt-cache
```

Use the corresponding MiMo OpenAI-compatible base URL and model for the second provider. If an endpoint does not return cache token details, the runner reports the sample as unavailable instead of deriving a hit rate from billing assumptions.

### Observed MiMo-compatible A/B

A credentialed run of commit `8f693ce` against an OpenAI-compatible MiMo endpoint on 2026-07-17T18:40:17Z used `mimo-v2.5`, three turns per variant, and a three-second inter-request delay. The first request in each variant was treated as cold and excluded from warm aggregation.

| Layout | Sample | Prompt tokens | Cache hit | Cache miss | Hit rate |
|---|---:|---:|---:|---:|---:|
| Legacy | cold | 1,640 | unavailable | unavailable | unavailable |
| Legacy | warm 1 | 1,640 | unavailable | unavailable | unavailable |
| Legacy | warm 2 | 1,640 | unavailable | unavailable | unavailable |
| Optimized | cold | 1,641 | unavailable | unavailable | unavailable |
| Optimized | warm 1 | 1,641 | 1,024 | 617 | 62.40% |
| Optimized | warm 2 | 1,641 | 1,024 | 617 | 62.40% |

The optimized warm aggregate was 2,048 cache-hit tokens and 1,234 cache-miss tokens, or 62.40%. The provider did not expose hit/miss details for any legacy sample, so the runner correctly emitted `hitRateDelta: null`; this report does not reinterpret a missing field as a zero-token hit. The controlled run nevertheless demonstrates that the optimized layout produced a repeatable 1,024-token reusable prefix where the legacy layout produced no reportable cache reuse under the same endpoint, model, request count, and delay.

### Observed DeepSeek official A/B

A credentialed run of the same benchmark protocol against the official DeepSeek API on 2026-07-17T18:47:11Z used `deepseek-v4-pro`, three turns per variant, and the same three-second inter-request delay.

| Layout | Sample | Prompt tokens | Cache hit | Cache miss | Hit rate |
|---|---:|---:|---:|---:|---:|
| Legacy | cold | 1,630 | 0 | 1,630 | 0% |
| Legacy | warm 1 | 1,630 | 0 | 1,630 | 0% |
| Legacy | warm 2 | 1,630 | 0 | 1,630 | 0% |
| Optimized | cold | 1,632 | 0 | 1,632 | 0% |
| Optimized | warm 1 | 1,632 | 0 | 1,632 | 0% |
| Optimized | warm 2 | 1,632 | 1,408 | 224 | 86.27% |

After excluding the cold requests, the legacy aggregate was 0 cache-hit and 3,260 cache-miss tokens (0%). The optimized aggregate was 1,408 cache-hit and 1,856 cache-miss tokens (43.14%), an observed improvement of 43.14 percentage points. In this run DeepSeek did not report a hit on the first warm request but reused a larger 1,408-token prefix on the second; the MiMo-compatible endpoint reported a 1,024-token hit on both warm requests. This is a controlled comparison of the observed endpoints, not a claim about provider-wide cache latency or production traffic.

## References

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Xiaomi MiMo API pricing and prefix-cache billing](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)
- [Xiaomi MiMo OpenAI-compatible Chat API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)
- [OpenClaw plugin prompt and model hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw system-prompt composition](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts)
- [OpenClaw cache boundary placement](https://github.com/openclaw/openclaw/blob/main/src/agents/system-prompt.ts)
