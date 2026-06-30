# Prompt Cache Hit Rate Optimization

## Issue
- **Issue**: [#120](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120) - Prompt Cache Hit Rate Regression
- **Problem**: After enabling memory-tencentdb plugin, DeepSeek and MiMo prompt cache hit rates degraded significantly

## Solution

### 1. Stable Wrapper Strategy
Implement `stableWrapper` optimization that outputs a placeholder when no memories are recalled, maintaining consistent prefix structure for prefix-matching cache.

```typescript
// Before: no output when no memories
// After: <relevant-memories>（本次对话未召回相关记忆）</relevant-memories>
```

### 2. Configuration Options
New `recall.cacheOptimization` config group:

```json
{
  "recall": {
    "cacheOptimization": {
      "stableWrapper": true,      // Default: true
      "splitSystemContext": true  // Default: true
    }
  }
}
```

### 3. Metrics Tracking
Added `RecallResult.stableWrapperUsed` field for metrics tracking.

## Files Changed

| File | Changes |
|------|---------|
| `src/config.ts` | Added `CacheOptimizationConfig` type |
| `src/core/hooks/auto-recall.ts` | Implemented stableWrapper logic |
| `src/core/types.ts` | Added `stableWrapperUsed` field |
| `openclaw.plugin.json` | Added config schema |
| `CHANGELOG.md` | Documented new feature |
| `src/core/hooks/__tests__/cache-optimization.test.ts` | Unit tests |

## Test Results

```
Test Files:  6 passed (6)
Tests:      All passed
```

## Expected Impact

- DeepSeek cache hit rate: 83.3% → 90%+
- MiMo cache hit rate: 63.5% → 85%+

Fixes #120
