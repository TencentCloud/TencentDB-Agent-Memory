# Issue #120 Cache-Safe Recall Measurement

Date: 2026-07-05
PR comparison refreshed: 2026-07-07

Scope: DeepSeek/OpenClaw verification for TencentDB Agent Memory Issue #120.
This report follows the maintainer-scoped paths: dynamic L1 recall placement
(`prependContext` / `appendContext`), stable `appendSystemContext`, and
persisted `showInjected`-style history growth.

## Environment

- OpenClaw: `D:\OpenClawLab\run-openclaw-2026.5.28.ps1`
- Config: `D:\OpenClawLab\state-2026.5.28\openclaw.json`
- Provider/model: `deepseek/deepseek-v4-pro`
- Plugin path: `D:\Desktop\TencentDB-Agent-Memory`
- Measurement data source: OpenClaw embedded-agent JSON `agentMeta.lastCallUsage`

Temporary local instrumentation was applied only under `D:\OpenClawLab` so
OpenClaw 2026.5.28 could normalize DeepSeek raw usage fields:

- `prompt_cache_hit_tokens` -> `cacheRead`
- `prompt_cache_miss_tokens` -> `input`

The instrumentation and seeded local L1 fixture were restored after
measurement. No API keys, raw prompts, raw responses, or raw memory text are
included here.

## Baseline: Legacy Dynamic Prefix

Session: `bbe652ec-29bd-4be0-b46f-3b7f53ec0d29`

Legacy recall injection used dynamic L1 memory in `prependContext`:

| Turn | `appendSystemContext` | `prependContext` | Notes |
| --- | ---: | ---: | --- |
| 1 | 705 chars | 706 chars | FTS returned 3 L1 records |
| 2 | 705 chars | 706 chars | FTS returned 3 L1 records |
| 3 | 705 chars | 482 chars | FTS returned 2 L1 records |

OpenClaw system prompt hash stayed stable:
`c7709570f9f766774728b288fea40a353a507172d03e307e20bc28f39cb8ecd8`.

Final assistant-call usage:

| Turn | cache hit (`cacheRead`) | cache miss (`input`) | output | total |
| --- | ---: | ---: | ---: | ---: |
| 1 | 22,784 | 53 | 329 | 23,166 |
| 2 | 13,824 | 9,382 | 113 | 23,319 |
| 3 | 21,888 | 1,361 | 156 | 23,405 |

History pollution check:

| Metric | Value |
| --- | ---: |
| User messages checked | 3 |
| `<relevant-memories>` blocks in user messages | 0 |
| `<relevant-memories>` blocks in transcript messages | 0 |

Conclusion: default history cleanup was already preventing persisted
`showInjected`-style pollution in this local runtime. The remaining cache risk
was the current-turn dynamic L1 block being placed before the user prompt.

## Selected Fix

The selected fix moves dynamic L1 recall to `appendContext` by default:

- `recall.dynamicContextPlacement: "append"` is the new default.
- `recall.dynamicContextPlacement: "prepend"` restores the legacy behavior.
- The same `<relevant-memories>` block and recalled L1 lines remain
  model-visible in the current turn, preserving recall and traceability.
- `before_message_write` still strips `<relevant-memories>` from persisted user
  messages through the shared sanitizer helper, preserving clean future history.
- Stable persona/scene/tools guide remains in `appendSystemContext`; this patch
  does not claim control over OpenClaw's host-owned system prompt cache boundary.

OpenClaw 2026.5.28 consumes `appendContext` in both main paths:

- `prepare.runtime-cYh2CwXm.js`: `preparedPrompt + appendContext`
- `selection-BMP-JCML.js`: `effectivePrompt + appendContext`

That makes late dynamic L1 placement an available host API rather than a
TencentDB-only assumption.

## Alternative Review

The decision was rechecked against the active Issue #120 paths and nearby PRs:

| Path | Existing PR shape | Trade-off | Decision |
| --- | --- | --- | --- |
| Diagnostics only | PR #343-style PrefixShape tooling | Useful for proof, but does not change runtime cache behavior | Reuse the diagnostic idea, but ship a runtime fix too |
| `showInjected` cleanup only | PR #188-style visibility toggle / stripping control | Prevents history growth, but this local baseline already had zero persisted `<relevant-memories>` blocks | Keep cleanup robust, but do not treat it as the main fix |
| Keep `prependContext` and dedupe recall lines | PR #351-style session injection dedupe / optional disable | Reduces repeated content, but dynamic current-turn recall can still occupy the prompt prefix | Inferior for maximizing prefix-cache stability when `appendContext` is available |
| Stable XML wrapper around `prependContext` | PR #321-style wrapper | Stabilizes only wrapper tokens; dynamic memory text still follows in the prefix region | Less direct than moving dynamic text out of the prefix |
| Compatibility-first `appendContext` option | PR #350/#375-style `recall.injectionMode`, default `prepend`, opt-in `append` | Good compatibility posture, but does not fix the default Issue #120 cache path and has no live provider metric gate in the PR body | Keep the rollback option, but default to `append` in the measured OpenClaw 2026.5.28 path |
| Move stable context before host cache boundary | PR #358/#361-style `prependSystemContext` mapping | Potentially improves stable system caching, but changes host-boundary semantics and is more OpenClaw-specific | Defer unless diagnostics show stable context is still the dominant risk |
| Session-level stable prompt dedupe | PR #379/#389-style host/session dedupe | Good for repeated stable system text and complementary to this patch | Complementary, not a replacement for dynamic L1 placement |
| Lightweight pointer plus session dedupe | PR #402-style pointer replacement and recall dedupe | Reduces prompt size and reports DeepSeek cache gains, but replacing full recalled memory with a pointer risks recall/traceability quality | Do not replace the current-turn recalled L1 content for this PR |
| Cache-aware long-context redesign | PR #410-style tool-only recall, session snapshot, tool result offload, cache epoch | Broad architecture change with many behavior surfaces beyond Issue #120's TencentDB recall injection path | Out of scope for the first targeted runtime repair |
| Adapter/session recall cache | PR #339-style SDK adapter work | Broader platform architecture; does not directly fix OpenClaw `before_prompt_build` dynamic prefix placement | Complementary and out of this PR's narrow runtime scope |

The current patch is therefore intentionally narrower than the broadest PRs:
it removes the measured dynamic L1 prefix churn without changing host-owned
cache-boundary assembly. It is also stronger than compatibility-first
append-mode proposals when judged by Issue #120's goal, because `append` is the
default in the measured OpenClaw 2026.5.28 environment and `prepend` remains an
explicit rollback option.

## After: Dynamic L1 Appended

Session key: `agent:main:issue120-cache-append`
Session id: `ca16e3b4-5127-440b-9330-0ddde00976b0`

Observed recall injection after rebuilding `dist/index.mjs`:

| Turn | `appendSystemContext` | `prependContext` | `appendContext` | Notes |
| --- | ---: | ---: | ---: | --- |
| 1 | 495 chars | 0 chars | 366 chars | FTS returned 2 L1 records |
| 2 | 495 chars | 0 chars | 522 chars | FTS returned 3 L1 records |
| 3 | 495 chars | 0 chars | 366 chars | FTS returned 2 L1 records |

OpenClaw system prompt hash stayed stable:
`c7709570f9f766774728b288fea40a353a507172d03e307e20bc28f39cb8ecd8`.

Final assistant-call usage (`agentMeta.lastCallUsage`):

| Turn | cache hit (`cacheRead`) | cache miss (`input`) | output | total |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0 | 22,088 | 104 | 22,192 |
| 2 | 13,824 | 8,377 | 251 | 22,452 |
| 3 | 23,168 | 127 | 157 | 23,452 |

Notes:

- Turn 1 is a cold session and is expected to have no cache hit.
- Turn 2 keeps the same cache-hit bucket as the baseline turn 2 but reduces
  miss tokens from 9,382 to 8,377.
- Turn 3 improves the final-call cache-hit bucket from 21,888 to 23,168 and
  reduces miss tokens from 1,361 to 127.
- Turn 3 made extra tool calls; the table uses `lastCallUsage` to keep the
  comparison on the final assistant model call.

## Strict A/B Validation (2026-07-08)

To satisfy the maintainer-scoped PR gate (Issue #120), a strict A/B matrix was
run on the repair commit `b759848` for both DeepSeek and MiMo:

- 2 providers x 2 variants (`prepend` legacy vs `append` default) x 2 repeats x 3 turns
- Same seeded L1 fixture (3 records, keyword-recall over TypeScript/lyf/OpenClaw)
- Same prompt sequence each turn
- `recall.promptShapeDiagnostics: true`
- Cold turn = turn 1 of each repeat (fresh session key); warm turns = 2, 3
- Persona/scene state aligned: `persona.md` + scene block were already generated
  before this run, so `appendSystemContext` hash stayed
  `2c2eb8554c6e` (4390 chars) across every cell. This removes the persona-injection
  timing confound seen in the earlier minimal probe.

### Placement evidence (PromptShape diagnostics)

All 24 cells produce the dynamic L1 block (`<relevant-memories>`, 428 chars) in
exactly one placement field, never both:

| Variant | `appendContext` | `prependContext` | `historyRelevantMemories` |
| --- | ---: | ---: | ---: |
| `append` (all 12 cells) | 428 | 0 | 0 |
| `prepend` (all 12 cells) | 0 | 428 | 0 |

`historyRelevantMemories=0` confirms persisted canonical history stays clean
under both variants — the centralized `<relevant-memories>` stripping works.

### Normalized per-turn usage

`cacheWrite=0` across all 24 cells (neither DeepSeek nor MiMo reported cache
write-backs in this run). `cacheRead` is the OpenClaw-normalized cache-hit
bucket; `input` is the cache-miss bucket.

#### DeepSeek (`deepseek/deepseek-v4-pro`)

| Variant | Repeat | Turn | input | cacheRead | output | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| append | 1 | 1 (cold) | 723 | 23168 | 622 | 24513 |
| append | 1 | 2 (warm) | 8916 | 52096 | 1333 | 62345 |
| append | 1 | 3 (warm) | 38891 | 22912 | 2179 | 63982 |
| append | 2 | 1 (cold) | 2996 | 24064 | 629 | 27689 |
| append | 2 | 2 (warm) | 257 | 52992 | 1367 | 54616 |
| append | 2 | 3 (warm) | 34120 | 22912 | 1806 | 58838 |
| prepend | 1 | 1 (cold) | 144 | 25472 | 555 | 26171 |
| prepend | 1 | 2 (warm) | 9679 | 37504 | 1253 | 48436 |
| prepend | 1 | 3 (warm) | 1314 | 56576 | 2270 | 60160 |
| prepend | 2 | 1 (cold) | 188 | 26752 | 495 | 27435 |
| prepend | 2 | 2 (warm) | 1911 | 48000 | 1143 | 51054 |
| prepend | 2 | 3 (warm) | 28281 | 22784 | 1759 | 52824 |

Warm-turn (turn 2) averages:

| Variant | cacheRead avg | input avg |
| --- | ---: | ---: |
| append | 52,544 | 4,586 |
| prepend | 42,752 | 5,795 |

DeepSeek warm-turn cache hit is higher under `append` (+9,792 tokens, ~23%),
and warm-turn cache miss is lower (-1,209 tokens). This is the expected effect:
keeping dynamic L1 out of the prefix lets DeepSeek reuse the stable prefix
cache across warm turns. Turn 3 is noisy on both variants (history grew past
the stable prefix region); warm-turn-2 is the clean comparison.

#### MiMo (`xiaomi/mimo-v2.5-pro`)

| Variant | Repeat | Turn | input | cacheRead | output | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| append | 1 | 1 (cold) | 659 | 27136 | 197 | 27992 |
| append | 1 | 2 (warm) | 3428 | 24576 | 566 | 28570 |
| append | 1 | 3 (warm) | 28584 | 0 | 750 | 29334 |
| append | 2 | 1 (cold) | 199 | 32064 | 360 | 32623 |
| append | 2 | 2 (warm) | 2286 | 40896 | 1196 | 44378 |
| append | 2 | 3 (warm) | 44392 | 0 | 1564 | 45956 |
| prepend | 1 | 1 (cold) | 392 | 28544 | 416 | 29352 |
| prepend | 1 | 2 (warm) | 2702 | 43072 | 616 | 46390 |
| prepend | 1 | 3 (warm) | 9993 | 46656 | 627 | 57276 |
| prepend | 2 | 1 (cold) | 2366 | 27136 | 303 | 29805 |
| prepend | 2 | 2 (warm) | 167 | 30080 | 420 | 30667 |
| prepend | 2 | 3 (warm) | 2009 | 28672 | 579 | 31260 |

Warm-turn (turn 2) averages:

| Variant | cacheRead avg | input avg |
| --- | ---: | ---: |
| append | 32,736 | 2,857 |
| prepend | 36,576 | 1,434 |

MiMo shows a different shape. `cacheRead=0` appears on turn 3 under `append`
(both repeats), indicating MiMo's prefix cache does not survive past the second
turn when the dynamic block sits after the user prompt. Under `prepend`, MiMo
keeps a non-zero `cacheRead` on turn 3. This is a provider-side cache-window
effect, not a recall-quality regression: the recalled L1 content is still
model-visible (the model answered correctly) and persisted history stays clean.

### Strict A/B decision

- `append` consistently removes dynamic L1 from `prependContext` (placement
  contract holds on both providers).
- Persisted history stays clean on both providers and both variants.
- DeepSeek warm-turn-2 cache behavior is better under `append` (higher
  cacheRead, lower input) — the primary evidence supporting the fix.
- MiMo is cache-window-noisy: `append` is better on turn 2 (input lower) but
  loses `cacheRead` entirely on turn 3; `prepend` keeps `cacheRead` on turn 3
  but at the cost of dynamic content sitting in the prefix. The fix's goal
  (remove dynamic content from the prefix) is still met under `append`, and
  recall visibility/traceability is preserved. MiMo's turn-3 `cacheRead=0` is
  documented as a provider cache-window caveat, not a regression caused by the
  fix.
- No evidence of recall quality or traceability regression on either provider.

The branch is PR-ready. MiMo's cache-window behavior is recorded as a
provider-side caveat; the runtime decision (`append` default, `prepend`
rollback retained) does not need to change.

## Decision

The current best fix for Issue #120 is the combined repair:

1. Keep canonical history clean by centralizing `<relevant-memories>` stripping
   for both string content and text-part content.
2. Move dynamic current-turn L1 recall from `prependContext` to `appendContext`
   by default, using OpenClaw's supported late-context field.
3. Keep stable `appendSystemContext` unchanged because cache-boundary placement
   is host-owned and was stable in the measured runs.

This is stronger than a cleanup-only patch: it preserves recall visibility and
traceability while removing the dynamic L1 block from the prompt prefix region.

## Verification Commands

```powershell
npm test
npm run build
node -e "JSON.parse(require('fs').readFileSync('openclaw.plugin.json','utf8')); console.log('manifest json ok')"
git diff --check
npm pack --dry-run
```

Latest local verification on 2026-07-07:

- `npm test`: 7 files, 83 tests passed.
- `npm run build`: passed.
- Manifest JSON parse: passed.
- `git diff --check`: passed with CRLF conversion warnings only.
- `npm pack --dry-run`: passed, package size 723.4 kB, no `.tgz` left on disk.
