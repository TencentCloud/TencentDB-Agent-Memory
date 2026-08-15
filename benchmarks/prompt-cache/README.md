# Prompt-cache validation environment

This package is isolated from the plugin runtime. It has no dependencies and
uses Node.js built-ins only.

## Local checks

From the repository root:

```bash
npm run benchmark:prompt-cache:doctor
npm run benchmark:prompt-cache:test
npm run benchmark:prompt-cache:offline
```

Results are written under `benchmark-runs/issue-120/`, which is ignored by Git.

## Local OpenClaw 2026.5.28 smoke

Install the exact OpenClaw version under the ignored benchmark directory, build
the current plugin source, and link it into an isolated OpenClaw instance:

```bash
npm run benchmark:prompt-cache:openclaw:setup
```

The script sets `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and
`OPENCLAW_CONFIG_PATH`. The CLI, workspace, config, plugin registry, and runtime
state therefore remain under `benchmark-runs/issue-120/`; the script does not
use the host's default `~/.openclaw` instance.

## Direct provider A/B

Export credentials locally:

```bash
export PROMPT_CACHE_BENCH_BASE_URL="https://api.deepseek.com/v1"
export PROMPT_CACHE_BENCH_API_KEY_FILE="/tmp/issue-120-deepseek.key"
export PROMPT_CACHE_BENCH_MODEL="deepseek-v4-pro"
npm run benchmark:prompt-cache:provider
```

Create the temporary key file without echoing the key or putting it in shell
history:

```bash
umask 077
read -rsp "DeepSeek API key: " issue120_deepseek_key
printf '%s' "${issue120_deepseek_key}" > /tmp/issue-120-deepseek.key
unset issue120_deepseek_key
```

The runner prints and stores usage only. It does not log the API key or response
content. Run both variant orders:

```bash
PROMPT_CACHE_BENCH_ORDER=legacy,optimized npm run benchmark:prompt-cache:provider
PROMPT_CACHE_BENCH_ORDER=optimized,legacy npm run benchmark:prompt-cache:provider
```

This microbenchmark isolates stable system-context placement. It does not claim
to reproduce OpenClaw transcript persistence, compaction, or tool truncation.

## OpenClaw + published plugin + DeepSeek

The end-to-end runner starts a loopback recording proxy, runs the pinned local
OpenClaw 2026.5.28 CLI, and reads the raw DeepSeek cache fields before
OpenClaw normalizes provider usage. It stores only prompt hashes, sizes,
message roles, marker counts, and usage; prompt and response content are not
written to the result. Successful runs delete their temporary OpenClaw
home/state/workspace by default; set
`PROMPT_CACHE_KEEP_RUNTIME_ARTIFACTS=1` only for local debugging.

Run the three isolated groups:

```bash
PROMPT_CACHE_OPENCLAW_GROUP=off \
  npm run benchmark:prompt-cache:openclaw

PROMPT_CACHE_OPENCLAW_GROUP=inert \
  npm run benchmark:prompt-cache:openclaw

PROMPT_CACHE_OPENCLAW_GROUP=recall \
  npm run benchmark:prompt-cache:openclaw
```

All commands read the credential from
`PROMPT_CACHE_BENCH_API_KEY_FILE` (default:
`/tmp/issue-120-deepseek.key`). Each run creates a new directory under:

```text
benchmark-runs/issue-120/deepseek-v4-pro/openclaw/
├── g0/  # plugin off
├── g1/  # published 0.3.6 loaded, all active features off
└── g2/  # published 0.3.6 keyword Recall on, deterministic SQLite fixture
```

By default, both plugin groups load the verified published
`memory-tencentdb@0.3.6` artifact. Set
`PROMPT_CACHE_OPENCLAW_PLUGIN_PATH` to an absolute candidate source/package
directory for an A/B run, and `PROMPT_CACHE_OPENCLAW_BIN` to override the
pinned CLI location. The Recall fixture is synthetic and is created inside the
run-specific state directory.

Each `result.json` contains `transcriptReplay` checks. A check passes only when
the hash of turn N's provider-visible current user message equals the hash of
the corresponding historical user message in turn N+1.

## Docker

Offline benchmark:

```bash
docker compose -f benchmarks/prompt-cache/compose.yaml run --rm offline
```

Provider benchmark:

```bash
docker compose -f benchmarks/prompt-cache/compose.yaml run --rm provider
```

OpenClaw 2026.5.28 CLI/plugin smoke:

```bash
docker compose -f benchmarks/prompt-cache/compose.yaml --profile openclaw \
  build openclaw-legacy
docker compose -f benchmarks/prompt-cache/compose.yaml --profile openclaw \
  run --rm openclaw-legacy
```

The OpenClaw container sets an isolated home, state directory, and config path
under its own `/state` volume and does not touch the host's `~/.openclaw`. If
`DEEPSEEK_API_KEY` is exported, the smoke script also runs non-interactive
DeepSeek onboarding and lists the provider models; it does not send a billable
model request.
