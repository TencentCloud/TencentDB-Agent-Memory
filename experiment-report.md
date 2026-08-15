# Issue #120: Prompt Cache Hit Rate Degradation — Fix & Ablation Experiment

## 1. Problem Summary

The `memory-tencentdb` plugin injects three types of content into each user request:

| Layer | Content | Source | Size | Cache Behavior |
|:---|:---|:---|:---|:---|
| **L1** | Dynamic memory recall (`<relevant-memories>`) | Vector/FTS search | 500–1700 tokens | Changes every turn → **must not be cached** |
| **L2** | Scene navigation | `scene_index.json` | ~2000 chars | Stable → **should be cached** |
| **L3** | User persona | `persona.md` | ~2000 chars | Stable → **should be cached** |
| — | Memory tools guide | Hardcoded constant | ~500 chars | Stable → **should be cached** |

Two independent issues cause prompt cache invalidation:

### Issue 1 (Primary): History pollution from `prependContext`

When `showInjected=true` (or when stripping is disabled), the dynamic `<relevant-memories>` content is written into conversation history. Each turn's history grows by 500–1700 tokens of non-repeating content. Over multiple turns, this triggers **dynamic truncation** (`tool result truncation`), where the truncation point shifts every turn. Because the conversation history is at the front of the prompt, a shifting truncation point changes the entire prompt prefix → **prefix cache always misses**.

### Issue 2 (Secondary): Stable content placed after `CACHE_BOUNDARY`

The L2 scene navigation, L3 persona, and memory tools guide are **static** across turns when the user's profile and scene index haven't changed. However, they were placed in `appendSystemContext`, which OpenClaw's `composeSystemPromptWithHookContext` appends **after** the `CACHE_BOUNDARY` marker. Content after the boundary is excluded from the cacheable prefix. Additionally, runtime-injected dynamic fields (session ID, timestamp) before the stable content further change the hash of the prefix. The net effect: even though the stable content bytes are identical, the **cache key** changes every request → cache miss.

---

## 2. Code Changes

### 2.1 Fix 1: `showInjected` Config (Primary Cause)

**Files modified:**
- [src/config.ts](src/config.ts) — Added `showInjected: boolean` to `RecallConfig` (default `false`)
- [index.ts](index.ts) — Made `before_message_write` stripping conditional on `!cfg.recall.showInjected`

**Change in `RecallConfig` interface (`config.ts:97-102`):**
```typescript
export interface RecallConfig {
  // ... existing fields ...
  /**
   * Whether to show injected <relevant-memories> content in conversation history.
   * When false (default), injected memories are stripped before messages are persisted,
   * preventing history inflation and preserving prompt cache hit rate.
   * Set to true for debugging to see what was injected in the transcript.
   */
  showInjected: boolean;
}
```

**Change in `before_message_write` hook (`index.ts:619-651`):**
```typescript
api.on("before_message_write", (event) => {
  // When showInjected is true, keep injected content visible in the transcript
  if (cfg.recall.showInjected) return;
  // ... existing stripping logic ...
});
```

**Effect:** When `showInjected=false` (default), `<relevant-memories>` blocks are stripped from user messages before they're written to the session JSONL. The conversation history stays clean — no inflation, no shifting truncation points, stable prefix → cache hits.

### 2.2 Fix 2: Stable Content Before `CACHE_BOUNDARY` (Secondary Cause)

**Files modified:**
- [src/core/types.ts](src/core/types.ts) — Added `prependSystemContext` to `RecallResult`
- [src/core/hooks/auto-recall.ts](src/core/hooks/auto-recall.ts) — Moved stable content from `appendSystemContext` to `prependSystemContext`

**Change in `RecallResult` interface (`types.ts:199-213`):**
```typescript
export interface RecallResult {
  prependContext?: string;
  /** Stable recall context prepended to system prompt BEFORE CACHE_BOUNDARY */
  prependSystemContext?: string;
  /** Stable recall context appended to system prompt (deprecated) */
  appendSystemContext?: string;
  // ... metric fields ...
}
```

**Change in `auto-recall.ts:192-234`:**
```typescript
// Stable content goes into prependSystemContext (before CACHE_BOUNDARY)
const stableContent = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;
const useLegacyAppend = process.env.MEMORY_TDAI_STABLE_SYSTEM_APPEND === "1";
const prependSystemContext = !useLegacyAppend ? stableContent : undefined;
const appendSystemContext = useLegacyAppend ? stableContent : undefined;
```

**Effect:** By default, stable content (persona, scene nav, tools guide) is placed in `prependSystemContext`, which the OpenClaw framework inserts **before** the `CACHE_BOUNDARY` marker. This makes the stable content part of the cacheable prefix. When identical across turns, the cache key matches → cache hit.

The `MEMORY_TDAI_STABLE_SYSTEM_APPEND` environment variable provides a backward-compatible toggle for ablation testing. Set to `"1"` to use the legacy `appendSystemContext` path.

---

## 3. Ablation Experiment Design

### 3.1 Conditions

| Condition | `showInjected` | Stable Content Position | Expected Cache Behavior |
|:---|:---|:---|:---|
| **A** (Baseline) | `true` | After `CACHE_BOUNDARY` | Both issues active → near-zero hit rate |
| **B** (Fix 1 only) | `false` | After `CACHE_BOUNDARY` | History clean, but stable content still after boundary |
| **C** (Fix 2 only) | `true` | Before `CACHE_BOUNDARY` | Stable content cached, but history still polluted |
| **D** (Combined) | `false` | Before `CACHE_BOUNDARY` | Both issues resolved → maximum hit rate |

### 3.2 Hypothesis

- **H1**: Fix 1 alone (B) should improve hit rate by keeping conversation history stable → the prefix stays consistent → fewer cache misses from shifting truncation.
- **H2**: Fix 2 alone (C) should improve hit rate by placing stable system content before `CACHE_BOUNDARY` → the persona/scene/tools portion of the system prompt is cacheable.
- **H3**: The combined fix (D) should yield the highest hit rate, as both sources of cache invalidation are addressed.
- **H4**: Cold start (Turn 1) always has 0% hit rate regardless of condition, since no cached prefix exists yet.

### 3.3 Test Protocol

1. **Clean context**: Delete all history files, SQLite databases, persona, and scene index before each iteration.
2. **Configure**: Set environment variables `MEMORY_TDAI_SHOW_INJECTED` and `MEMORY_TDAI_STABLE_SYSTEM_APPEND` per condition (no `openclaw.json` modification needed).
3. **Send 5-turn conversation**: Each turn triggers memory recall (L1) and stable content injection (L2/L3).
4. **Collect metrics**: Extract `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` from each API response's `usage` field.
5. **Compute**: `hit_rate = cache_hit_tokens / (cache_hit_tokens + cache_miss_tokens)` per turn.
6. **Repeat**: 3 iterations per condition, excluding Turn 1 (cold start) from averages.

### 3.4 Test Script

Run with:
```bash
# Single condition
python scripts/run_experiment.py --condition A --iterations 3

# All conditions
python scripts/run_experiment.py --all --iterations 3

# Dry run (validate configs without API calls)
python scripts/run_experiment.py --all --iterations 3 --dry-run
```

The script automatically:
1. Cleans `~/.openclaw/state/memory-tdai/` before each iteration
2. Sets `MEMORY_TDAI_SHOW_INJECTED` and `MEMORY_TDAI_STABLE_SYSTEM_APPEND` env vars per condition
3. Sends 5 preset conversation turns via OpenClaw Gateway API
4. Extracts `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` from responses
5. Saves per-condition JSON results to `./experiment-results/`

---

## 4. Expected Results (Projected)

Based on the analysis of the two independent failure modes:

```
Condition A (baseline):
  Turn 1: hit 0.0% (cold start)
  Turn 2: hit 0.0% — history already diverged + stable content after boundary
  Turn 3: hit 0.0% — compounding history divergence
  Turn 4: hit 0.0%
  Turn 5: hit 0.0%
  Average (T2–T5): ~0.0%

Condition B (Fix 1 only):
  Turn 1: hit 0.0% (cold start)
  Turn 2: hit 15–30% — history clean, but stable content still after boundary
  Turn 3: hit 15–30% — same reason
  Average (T2–T5): ~20%

Condition C (Fix 2 only):
  Turn 1: hit 0.0% (cold start)
  Turn 2: hit 5–15% — stable content cached, but history pollution shifts prefix
  Turn 3: hit 0–5%  — history continues to diverge
  Average (T2–T5): ~5%

Condition D (Combined):
  Turn 1: hit 0.0% (cold start)
  Turn 2: hit 70–90% — clean history + stable system prefix both cacheable
  Turn 3: hit 80–95% — prefix mostly stabilized
  Turn 4: hit 85–95%
  Turn 5: hit 85–95%
  Average (T2–T5): ~85%
```

**Key insight**: Fix 1 (history cleanup) is the **dominant** fix because it prevents the entire prompt prefix from shifting. Fix 2 adds incremental gain by making stable system content cacheable. Together, they should achieve >80% cache hit rate for multi-turn conversations, compared to near-zero baseline.

---

## 5. Verification Checklist

- [ ] After Fix 1: Multi-turn conversation history in `sessions/*.jsonl` should NOT contain `<relevant-memories>` blocks when `showInjected=false`.
- [ ] After Fix 1: When `showInjected=true`, `<relevant-memories>` blocks ARE present in history (for debugging).
- [ ] After Fix 2: `prependSystemContext` is populated in the `before_prompt_build` hook return (check logs).
- [ ] After Fix 2: `MEMORY_TDAI_STABLE_SYSTEM_APPEND=1` env var switches back to legacy `appendSystemContext` behavior.
- [ ] Experiment script runs all 4 conditions without errors.
- [ ] Condition D consistently shows the highest cache hit rate.

---

## 6. Framework-Side Change Required

The plugin-side changes assume OpenClaw framework supports `prependSystemContext` in the `before_prompt_build` hook return type. If the framework does not yet support this field, the following change is needed in the OpenClaw host:

**File:** `composeSystemPromptWithHookContext` (in OpenClaw's prompt assembly module)

**Change:** Add support for `prependSystemContext` from hook results, placing it before `CACHE_BOUNDARY`:

```typescript
// In composeSystemPromptWithHookContext:
const { prependSystemContext, appendSystemContext } = hookResult;

// prependSystemContext goes BEFORE CACHE_BOUNDARY (cacheable)
if (prependSystemContext) {
  systemPromptParts.unshift(prependSystemContext); // At the start
}

// appendSystemContext stays AFTER CACHE_BOUNDARY (not cached)
if (appendSystemContext) {
  systemPromptParts.push(appendSystemContext); // At the end
}
```

Without this framework change, `prependSystemContext` from the plugin will be ignored, and Fix 2 will have no effect.

---

## 7. Files Changed Summary

| File | Change |
|:---|:---|
| [src/config.ts](src/config.ts) | Added `showInjected: boolean` to `RecallConfig` interface and parser (default `false`) |
| [src/core/types.ts](src/core/types.ts) | Added `prependSystemContext` field to `RecallResult` interface |
| [src/core/hooks/auto-recall.ts](src/core/hooks/auto-recall.ts) | Stable content now defaults to `prependSystemContext`; legacy `appendSystemContext` path behind `MEMORY_TDAI_STABLE_SYSTEM_APPEND` env var |
| [index.ts](index.ts) | `before_message_write` hook stripping gated by `cfg.recall.showInjected`; logging updated for `prependSystemContext` |
| [scripts/run_experiment.py](scripts/run_experiment.py) | **New** — automated ablation experiment runner |
