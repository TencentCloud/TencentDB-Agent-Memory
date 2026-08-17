# Plandex adapter for TencentDB Agent Memory

This adapter connects [Plandex](https://plandex.ai) to
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
through the project's **MemoryProxy** OpenAI-compatible route, so Plandex
plans, code, commits and long-running tasks become team memory instead of a
throw-away local session.

> Season 2 scope: see
> [#926 Adapters Wanted](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/926).

## How it works

Plandex talks OpenAI Chat Completions to any custom, OpenAI-compatible
provider. We register the MemoryProxy as such a provider:

```text
Plandex (custom provider)
        │  POST /proxy/<spaceId>/v1/chat/completions
        ▼
MemoryProxy :8096  ── session init / memory injection / write-back
        │
        ├────────► upstream LLM (PROXY_UPSTREAM_MODEL)
        └─HTTP───► MemoryCore :8420 (L0/L1/L2/L3 memory pipeline)
```

The generated `custom-models.json` declares:

- a provider named `tencentdb-agent-memory` whose `baseUrl` is
  `http://127.0.0.1:8096/proxy/<spaceId>/v1` and whose key lives in
  `TDAI_USER_KEY`;
- one model, `tencentdb/tdai-memory-agent`, mapped to the proxy's upstream
  model through that provider;
- one model pack, `tdai-memory-pack`, that assigns the memory-backed model to
  every Plandex role (planner, coder, architect, summarizer, builder, names,
  commit messages).

## Prerequisites

1. The three-piece stack from
   [`deploy/global-images`](../../deploy/global-images/README.md) is running
   (MemoryCore `:8420`, MemoryProxy `:8096`, Memory Hub `:8125`).
2. A business user key (`sk-mem-...`) was created in the Memory Hub. Do **not**
   use the admin key for daily work.
3. Plandex in **self-hosted** mode. Plandex only supports custom providers
   when self-hosting (custom models/packs alone work in Cloud BYO mode, but
   they cannot point at an arbitrary base URL).
4. Node.js >= 22.16 for the helper CLI (zero npm dependencies).

## Quick start

```bash
# 1. Point the adapter at your stack
export TDAI_UPSTREAM_MODEL="<model id in PROXY_UPSTREAM_MODEL>"  # e.g. gpt-5.5
export TDAI_USER_KEY="sk-mem-..."                                 # business user key
# optional: TDAI_PROXY_BASE_URL / TDAI_CORE_BASE_URL / TDAI_SPACE_ID

# 2. Verify every hop, including a one-token chat round-trip
node tdai-plandex.mjs check --probe

# 3. Generate the Plandex config and feed it to "plandex models custom"
node tdai-plandex.mjs generate --dry-run
# or write it directly:
node tdai-plandex.mjs generate --output ./custom-models.json
```

Then in Plandex select the `tdai-memory-pack` model pack (see Plandex's model
pack docs for the current selection command). Make sure `TDAI_USER_KEY` is
exported in every shell that runs `plandex`.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `TDAI_UPSTREAM_MODEL` | required | Model id configured as `PROXY_UPSTREAM_MODEL`. |
| `TDAI_USER_KEY` | required for `check` | Business user key (`sk-mem-...`). |
| `TDAI_PROXY_BASE_URL` | `http://127.0.0.1:8096` | MemoryProxy base URL. |
| `TDAI_CORE_BASE_URL` | `http://127.0.0.1:8420` | MemoryCore Gateway base URL. |
| `TDAI_SPACE_ID` | `default` | Memory instance id embedded in `/proxy/<spaceId>/`. |
| `TDAI_MAX_OUTPUT_TOKENS` | `8192` | `maxOutputTokens` / `reservedOutputTokens`. |
| `TDAI_DEFAULT_MAX_CONVO_TOKENS` | `128000` | `defaultMaxConvoTokens`. |

## CLI

```text
tdai-plandex generate [--output <file>] [--dry-run] [--force]
tdai-plandex check [--probe]
```

- `generate --dry-run` prints the JSON without touching disk.
- `generate --output <file>` refuses to overwrite an existing file unless
  `--force` is given.
- `check` verifies proxy and core health; `--probe` adds a real one-token chat
  completion through `/proxy/<spaceId>/v1/chat/completions`, exercising auth
  and upstream forwarding end to end.

## First-run session init

On the first turn of a new session the proxy performs session init and may ask
you to choose **Team -> Agent -> Task** so memory is attached to the right
place. Complete that form once; later turns are bound automatically. If you
see nothing persisted, check the Memory Hub's memory view and the output of
`tdai-plandex.mjs check --probe`.

## Tests

The adapter ships with a dependency-free test suite (Node's built-in test
runner), including a local mock gateway integration test, written tests-first:

```bash
cd adapters/plandex
npm test
npm run test:coverage   # prints line/branch/function coverage
```

Coverage: config generation and validation, URL edge cases, environment
parsing and diagnostics, proxy/core health checks, the chat probe's exact
route and `x-tdai-user-key` / `Authorization` headers, CLI behavior (dry-run,
overwrite safety), and a bilingual documentation guard matching the official
Season 2 rule.
