# Prompt-cache layout A/B (no OpenClaw)

Measures whether putting the **stable memory block before** the base system prompt improves prefix-cache hit rate vs putting it **after** (legacy `appendSystemContext`-like layout).

## Setup

1. Copy env template (if needed):

```powershell
cd D:\projects\TencentDB-Agent-Memory
Copy-Item .env.example .env
```

2. Edit `.env`:

| Variable | Required | Example |
|----------|----------|---------|
| `DS_BASE_URL` | yes | `https://your-relay.example/v1` |
| `DS_API_KEY` | yes | your key |
| `DS_MODEL` | yes | model id on the relay |
| `DS_TURNS` | no | `4` (default) |
| `DS_WARM_ONLY` | no | `true` — exclude cold first turn |
| `DS_TIMEOUT_MS` | no | `60000` |

`.env` is gitignored. Do not commit keys.

## Run

```powershell
cd D:\projects\TencentDB-Agent-Memory
npm run bench:cache
# or
node scripts/benchmark-prompt-cache.mjs
```

## Output

- Console: legacy vs optimized hit rate summary
- `benchmark-runs/prompt-cache-ab-latest.json` — full sanitized report (no API key, no full replies)

If the relay strips cache fields (`prompt_cache_hit_tokens` / `cached_tokens`), hit rate shows `N/A` but the layout still ran.

## What it does / does not

| Does | Does not |
|------|----------|
| Call OpenAI-compatible `/chat/completions` | Install or run OpenClaw |
| Compare system stable-prefix layouts | Test host `before_prompt_build` hooks |
| Parse DeepSeek-style cache usage when present | Log secrets or full model output |
