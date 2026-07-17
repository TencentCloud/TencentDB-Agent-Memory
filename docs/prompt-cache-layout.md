# Prompt-cache layout for memory recall

This note documents the TencentDB-specific scope of [Issue #120](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120).
The issue reporter later confirmed that the observed webchat collapse was caused by an OpenClaw regression, not by this plugin. The layout below therefore addresses the remaining, independently reproducible optimization: stable memory context should be part of the reusable system-prompt prefix.

## Context structure

OpenClaw composes hook-provided system context in this order:

```text
prependSystemContext + baseSystemPrompt + appendSystemContext
```

`prependSystemContext` is present in the project's declared minimum supported OpenClaw release (`v2026.3.13-1`), so this placement change does not require a host-version bump.

The base prompt itself contains a cache boundary followed by volatile runtime context. Before this change, stable memory context was appended after that volatile tail:

```text
System prompt (before)
├─ OpenClaw stable system sections                 reusable
├─ CACHE_BOUNDARY
├─ volatile runtime/session sections               changes between turns
└─ appendSystemContext
   ├─ user persona                                 stable, but behind volatility
   ├─ scene navigation                             semi-stable, but behind volatility
   └─ memory tools guide                           static, but behind volatility

User prompt
├─ prependContext: <relevant-memories>             dynamic per query
└─ original user text                              dynamic per turn

Persisted history
└─ original user text                              injected block is stripped
```

A prefix-matching provider stops reusing tokens at the first changed token. Stable content placed after the volatile runtime section is consequently outside the common prefix.

After this change:

```text
System prompt (after)
├─ prependSystemContext
│  ├─ user persona                                 stable and reusable
│  ├─ scene navigation                             semi-stable and reusable until L2 changes
│  └─ memory tools guide                           static and reusable
├─ OpenClaw stable system sections                 reusable
├─ CACHE_BOUNDARY
└─ volatile runtime/session sections               changes between turns

User prompt
├─ prependContext: <relevant-memories>             dynamic per query
└─ original user text                              dynamic per turn

Persisted history
└─ original user text                              injected block is stripped
```

The Gateway/Hermes response still joins the stable system-context fields, so moving the OpenClaw placement does not remove persona or scene content from other hosts.

## `showInjected` growth model

If a dynamic recall block of `R` tokens is persisted on every turn, the final request carries approximately `R × (N - 1)` stale recall tokens after `N` turns. The aggregate replay across the session grows quadratically:

```text
aggregate replay = R × N × (N - 1) / 2
```

For the issue's reported 500–1,700 tokens per recall and a 100-turn session:

| Measure | 500 tokens/turn | 1,700 tokens/turn |
|---|---:|---:|
| Extra recall in the final request | 49,500 | 168,300 |
| Aggregate recall replay | 2,475,000 | 8,415,000 |

Current `main` removes `<relevant-memories>` before message persistence. The canonical runtime mitigation in PR #375 retains that safe default and makes history visibility an explicit option. This change does not duplicate that injection-mode work.

## Options considered

1. **Move stable memory context to the cacheable prefix — implemented here.** It has no per-session state, preserves prompt content, and directly fixes a deterministic placement problem.
2. **Append dynamic L1 recall after the user query — PR #375.** This can improve automatic prefix reuse but is host-specific and should remain an explicit compatibility mode.
3. **Session-level recall deduplication — not selected.** It needs invalidation rules for topic changes, memory updates, restarts, and parallel turns; stale recall can cost more correctness than it saves tokens.
4. **Hide recall behind a pointer — not selected.** This reduces tokens but changes model-visible information and recall quality.

## Measurement

`auto-recall.test.ts` builds two turns with:

- the same persona/tools block of more than 4,000 characters;
- different recalled L1 memories;
- different volatile OpenClaw runtime tails.

It measures the longest common system-prompt prefix before and after placement. Moving the stable block from `appendSystemContext` to `prependSystemContext` increases reusable prefix span by exactly the stable block length plus its separator, while dynamic L1 recall remains outside the system prompt.

This is a deterministic prefix-reuse measurement, not a fabricated provider hit-rate claim. A controlled provider A/B should use the same model, tool schemas, session seed, and prompt sequence, then aggregate provider usage as:

```text
hit rate = cache-hit input tokens / (cache-hit input tokens + cache-miss input tokens)
```

Exclude the cold first turn, run multiple repetitions, and report tool-call counts because different tool paths change the prompt independently of memory injection.

DeepSeek documents automatic prefix caching and exposes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. MiMo should be evaluated from its returned usage fields rather than assuming identical persistence or accounting behavior.

## References

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)
- [OpenClaw system-prompt composition](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts)
- [OpenClaw cache boundary placement](https://github.com/openclaw/openclaw/blob/main/src/agents/system-prompt.ts)
