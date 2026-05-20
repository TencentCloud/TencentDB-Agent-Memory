# TencentDB Agent Memory Codex Adapter

Codex adapter for the **memory-tencentdb** four-layer memory system
(L0 conversation capture -> L1 episodic extraction -> L2 scene blocks -> L3
persona synthesis).

The heavy lifting runs in the Node.js **Gateway** sidecar used by the other
TencentDB Agent Memory integrations. This adapter is a thin Codex plugin layer:
it translates Codex hooks and MCP tool calls into the Gateway API, keeps
Codex-specific state under the adapter data directory, and leaves the OpenClaw
and Hermes paths unchanged.

The adapter targets Codex as a host, including Codex CLI and Codex App.
It also includes extra Codex App adaptation and validation for App session
history, archived JSONL import, plugin-cache loading, and App-observed hook
behavior.

## Architecture

```text
Codex (CLI and App)
  +-- Hooks
  |   +-- SessionStart        -> scripts/session-start.mjs
  |   +-- UserPromptSubmit    -> scripts/user-prompt-submit.mjs
  |   +-- PreToolUse          -> scripts/pre-tool-use.mjs
  |   +-- PermissionRequest   -> scripts/permission-request.mjs
  |   +-- PostToolUse         -> scripts/post-tool-use.mjs
  |   +-- PreCompact          -> scripts/pre-compact.mjs
  |   +-- PostCompact         -> scripts/post-compact.mjs
  |   +-- Stop                -> scripts/stop.mjs
  +-- MCP
      +-- scripts/mcp-server.mjs
             +-- tdai_memory_search
             +-- tdai_conversation_search
             +-- tdai_offload_lookup
                    |
                    v  HTTP (127.0.0.1:8420 by default)
             memory-tencentdb Gateway
                +-- POST /recall
                +-- POST /capture
                +-- POST /search/memories
                +-- POST /search/conversations
                +-- POST /session/end
                +-- POST /seed
```

The Codex-specific integration lives in this directory. The shared changes
outside `codex-plugin/` are limited to host-neutral Gateway and seed support
used by sidecar clients: a lightweight root metadata endpoint, optional
`started_at` capture metadata, and opt-in full-pipeline waiting for `/seed`.

## Lifecycle Mapping

| Codex surface | Gateway or local path | Behavior |
| --- | --- | --- |
| `SessionStart` | `/recall`, `/search/memories`, selective `/search/conversations` | Restores project/session context and returns Codex `additionalContext` when useful context exists. |
| `UserPromptSubmit` | Local turn state, `/recall`, `/search/memories`, selective `/search/conversations`, local L0 JSONL fallback | Starts a pending turn, recalls relevant memory, and injects bounded context; if Gateway recall/search has no useful context, scans project-scoped local L0 JSONL as a last resort. |
| `PreToolUse` | Local turn state | Records tool intent and returns a compact memory/offload hint. |
| `PermissionRequest` | Local turn state | Records permission activity for the current turn. |
| `PostToolUse` | Local turn state, context-offload files | Records tool results and can replace large tool output with compact hook feedback plus a lookup reference. |
| `PreCompact` | `/capture` | Captures pending turn state before compaction. |
| `PostCompact` | `/session/end` | Flushes pending Gateway pipeline work after compaction. |
| `Stop` | `/capture`, periodic `/session/end` | Captures the completed Codex turn and flushes every `TDAI_CODEX_FLUSH_EVERY_N_TURNS` captured turns. |
| MCP `tdai_memory_search` | `/search/memories` | Searches L1 structured memory. |
| MCP `tdai_conversation_search` | `/search/conversations` | Searches L0 raw conversation history. |
| MCP `tdai_offload_lookup` | Local context-offload index | Retrieves exact redacted tool results by `node_id`, `tool_call_id`, or query. |

## Reliability Features

- **Gateway supervision** - the adapter can auto-discover and start the Gateway
  from a local TencentDB Agent Memory checkout, then poll `/health` before use.
- **Circuit breaker** - repeated Gateway failures pause calls for a short
  cooldown instead of slowing every hook invocation.
- **Bounded prompt injection** - empty Gateway search responses are not injected,
  recall output is capped by `TDAI_CODEX_CONTEXT_MAX_CHARS`, and tool hints are
  intentionally compact.
- **Injected-context cleanup** - adapter-controlled capture, import, transcript,
  and Gateway L0/L1 write paths strip TencentDB/Codex injected blocks before
  persistence to avoid recall feedback loops.
- **Local L0 fallback** - when Gateway recall/search is unavailable or empty,
  automatic prompt recall can stream recent local L0 JSONL and filter by the
  current Codex project session-key prefix.
- **Short-term offload lookup** - large `PostToolUse` output can be stored under
  local JSONL/ref/Mermaid artifacts and retrieved later even if the Gateway is
  temporarily unavailable.

## Installation Location

This directory (`codex-plugin/`) is the source of truth for the Codex adapter.
Codex loads it as a local plugin or from a local marketplace/cache copy.

The plugin manifest is:

```text
codex-plugin/.codex-plugin/plugin.json
```

It declares the Codex skill, bundled hook config, and bundled MCP server config.
The adapter also ships a machine-readable reuse contract:

```text
codex-plugin/adapter-profile.json
codex-plugin/hooks/hooks.codex.json
codex-plugin/.mcp.json
```

Codex can load these hooks as plugin-bundled hooks when `plugin_hooks` is
enabled, or as user-level hooks from `~/.codex/hooks.json`. When mirroring the
hook file into a user-level config, replace the plugin-root variable with the
installed adapter path because user-level hooks do not receive plugin-specific
environment variables. The bundled MCP config exposes memory search and offload
lookup tools; the manual `codex mcp add` command below is a fallback for local
development or older Codex builds.

## Reuse Contract

The adapter is intended to be installable from a copied plugin directory, a
Codex plugin cache, a package release, or a forked source checkout without
editing script files. The stable contract is:

- `adapter-profile.json` describes the adapter ID, host, entrypoints,
  runtime requirements, environment variables, and extension points.
- Hook and MCP configs refer to the plugin root through Codex-provided root
  variables instead of machine-specific absolute paths.
- Per-user state lives under `TDAI_CODEX_DATA_DIR` or the default
  `~/.memory-tencentdb/codex-memory-tdai`; copied adapters do not share state
  unless that directory is explicitly shared.
- Gateway autostart uses the package binary by default, so a copied adapter can
  run without importing dependencies from the plugin directory.
- Source-tree development is still supported by setting `TDAI_CODEX_TDAI_ROOT`
  to a local checkout.
- Fork, release, and tarball validation can override
  `TDAI_CODEX_GATEWAY_PACKAGE` without changing the adapter scripts.

Run the doctor before publishing, copying, or handing the adapter to another
Codex environment:

```bash
node codex-plugin/scripts/doctor.mjs
node codex-plugin/scripts/doctor.mjs --start --require-healthy --strict
node codex-plugin/scripts/query.mjs doctor --json
```

The doctor checks that manifest entrypoints exist, hook/MCP configs are
portable, adapter state is writable with private adapter-owned subdirectories,
the Gateway URL is loopback unless explicitly allowed, and the Gateway can be
launched from either a source checkout or package binary.

## Setup

From the TencentDB-Agent-Memory repository root:

```bash
npm install
```

Optional Codex adapter environment:

```bash
export TDAI_CODEX_TDAI_ROOT="/path/to/TencentDB-Agent-Memory"
export TDAI_CODEX_DATA_DIR="$HOME/.memory-tencentdb/codex-memory-tdai"
export TDAI_CODEX_GATEWAY_URL="http://127.0.0.1:8420"
export TDAI_CODEX_AUTOSTART=true
export TDAI_CODEX_FLUSH_EVERY_N_TURNS=5
# Tool-output offload is enabled by default; uncomment to disable it.
# export TDAI_CODEX_TOOL_OFFLOAD=false
```

When the adapter autostarts the Gateway it keeps the service on loopback by
default, creates a private bearer token under
`$TDAI_CODEX_DATA_DIR/codex-adapter/gateway-token`, and sends that token on
Gateway requests. The token is passed to the daemon through `TDAI_TOKEN_PATH`
instead of a generated token environment variable. Set `TDAI_CODEX_GATEWAY_TOKEN`
or `TDAI_TOKEN_PATH` if you want to manage the token yourself. Autostart refuses
non-loopback hosts unless `TDAI_CODEX_ALLOW_NON_LOOPBACK=true` is set explicitly.

By default autostart uses the package bin
(`npx --yes --ignore-scripts --package @tencentdb-agent-memory/memory-tencentdb tdai-memory-gateway`),
so the copied Codex plugin does not need to import package dependencies from the
plugin directory and daemon launch does not run npm lifecycle scripts. For
source-tree development, set `TDAI_CODEX_TDAI_ROOT` to use
`npx tsx src/gateway/server.ts` from a local checkout, or set
`TDAI_CODEX_GATEWAY_PACKAGE` to override the package spec, including a pinned
version or tarball during release validation. Package-bin launch does not
hydrate additional shell-only LLM secrets unless
`TDAI_CODEX_HYDRATE_ENV_FOR_PACKAGE_GATEWAY=true` is set explicitly.

The Gateway also rejects non-loopback browser origins by default and blocks
credential-bearing `/seed config_override` keys, so imported Codex history cannot
redirect configured LLM, embedding, TCVDB, or backend credentials to a different
network endpoint.

When no Gateway token is configured, unauthenticated loopback access is limited
to `GET` routes such as `/health`. Tokenless `POST` routes require the explicit
loopback-only development flag `TDAI_GATEWAY_AUTH_DISABLED=true`; non-loopback
tokenless access is always rejected.

Adapter requests also refuse non-loopback `TDAI_CODEX_GATEWAY_URL` values unless
`TDAI_CODEX_ALLOW_NON_LOOPBACK=true` is set explicitly. This prevents hooks from
sending local bearer tokens or captured memory to an unexpected remote URL.

For L1/L2/L3 extraction, configure an OpenAI-compatible LLM for the Gateway:

```bash
export TDAI_LLM_BASE_URL="https://api.openai.com/v1"
export TDAI_LLM_API_KEY="..."
export TDAI_LLM_MODEL="gpt-4o-mini"
```

The example Gateway config is `tdai-gateway.example.json`. Copy it to:

```bash
$TDAI_CODEX_DATA_DIR/tdai-gateway.json
```

or use environment variables only. During autostart the adapter sets
`TDAI_GATEWAY_CONFIG=$TDAI_CODEX_DATA_DIR/tdai-gateway.json`, because the Gateway
normally discovers config files from the current working directory or its
default data directory unless this variable is explicit.

## Register MCP Tools

The plugin bundles `codex-plugin/.mcp.json`, so normal Codex plugin installation
can register the MCP server from the plugin manifest. For local development,
or if a Codex build does not load plugin-bundled MCP config, register it
manually:

```bash
codex mcp add tdai-memory \
  --env TDAI_CODEX_TDAI_ROOT="/path/to/TencentDB-Agent-Memory" \
  --env TDAI_CODEX_DATA_DIR="$HOME/.memory-tencentdb/codex-memory-tdai" \
  --env TDAI_CODEX_GATEWAY_URL="http://127.0.0.1:8420" \
  --env TDAI_CODEX_AUTOSTART="true" \
  -- node "/path/to/TencentDB-Agent-Memory/codex-plugin/scripts/mcp-server.mjs"
```

MCP search tools are scoped to the current Codex project path by default. Pass
`all_projects: true` only when you intentionally want cross-project memory or
offload lookup.

For model-facing MCP safety, cross-project search and exact offload content are
not exposed by default. To opt in from outside the model context, set:

```bash
export TDAI_CODEX_MCP_ALLOW_ALL_PROJECTS=true
export TDAI_CODEX_MCP_ALLOW_OFFLOAD_CONTENT=true
```

## Diagnostics

```bash
node codex-plugin/scripts/gateway.mjs status
node codex-plugin/scripts/gateway.mjs start
node codex-plugin/scripts/query.mjs status
node codex-plugin/scripts/query.mjs memory "previous decision"
node codex-plugin/scripts/query.mjs conversation "continue where we left off"
node codex-plugin/scripts/query.mjs remember "This project uses X as the source of truth."
node codex-plugin/scripts/query.mjs flush
node codex-plugin/scripts/query.mjs seed ./historical-conversations.json
node codex-plugin/scripts/query.mjs import-codex-history --dry-run --since 30d
node codex-plugin/scripts/query.mjs import-codex-history --yes --since 30d --cwd "/path/to/project"
node codex-plugin/scripts/query.mjs offload list --all --limit 10
node codex-plugin/scripts/query.mjs offload node Cxxxxxx_N001 --content
node codex-plugin/scripts/query.mjs offload canvas
node codex-plugin/scripts/mcp-server.mjs
```

Logs:

```text
$TDAI_CODEX_DATA_DIR/codex-adapter/logs/gateway.stdout.log
$TDAI_CODEX_DATA_DIR/codex-adapter/logs/gateway.stderr.log
$TDAI_CODEX_DATA_DIR/codex-adapter/logs/hook.log
```

## Import Existing Codex History

The Gateway supports historical seeding through `POST /seed`. The Codex adapter
adds a host-specific importer that converts local Codex JSONL rollouts into
that seed format.

By default it reads:

```text
~/.codex/sessions/**/*.jsonl
~/.codex/archived_sessions/**/*.jsonl
```

The importer is opt-in and runs as a dry run unless `--yes` is provided:

```bash
node codex-plugin/scripts/import-codex-history.mjs --dry-run --since 30d
node codex-plugin/scripts/import-codex-history.mjs --yes --since 30d --cwd "/path/to/project"
```

It skips Codex-generated context scaffolding such as `AGENTS.md` injections and
imports only paired user/assistant rounds. Use `--no-archived` to exclude
archived sessions, `--limit` for a small trial import, and `--out` to inspect
the generated `/seed` payload before writing.

By default, a real import requests `wait_for_full_pipeline`, so Gateway `/seed`
records L0, waits for L1, flushes L2 scene extraction, and waits for L3 persona
generation before returning. Use `--no-full-pipeline` when the faster L0/L1-only
seed behavior is preferred. For large trusted local imports, `--l1-concurrency`
or `TDAI_CODEX_IMPORT_L1_CONCURRENCY` can raise bounded L1 extraction
parallelism without changing the live host default. The importer also sends
`l2_batch_size` by default, which lets Gateway coalesce many short historical
Codex sessions into larger L2 scene-extraction batches while keeping live
runtime L2 scheduling unchanged.

## Short-Term Context Offload

Codex does not expose OpenClaw's `slots.contextEngine`, so the adapter uses the
official Codex hook surface as the equivalent control point:

1. `PostToolUse` evaluates tool-result size against mild, aggressive, and
   emergency thresholds.
2. When offload is triggered, the full redacted result is written under
   `$TDAI_CODEX_DATA_DIR/codex-adapter/context-offload/<session>/refs/`.
3. A structured `offload-<session>.jsonl` entry is appended with `node_id`,
   `tool_call_id`, summary, score, policy, and `result_ref`.
4. The deterministic L2 canvas at `mmds/001-codex-tool-offload.mmd` is rebuilt
   and injected on later `SessionStart` / `UserPromptSubmit` hooks.
5. The model can drill down by calling `tdai_offload_lookup`; humans can use
   `query.mjs offload node ... --content`.

Thresholds are configurable:

```bash
export TDAI_CODEX_TOOL_OFFLOAD_MIN_CHARS=20000
export TDAI_CODEX_TOOL_OFFLOAD_AGGRESSIVE_MIN_CHARS=80000
export TDAI_CODEX_TOOL_OFFLOAD_EMERGENCY_MIN_CHARS=250000
export TDAI_CODEX_TOOL_OFFLOAD_PREVIEW_CHARS=2000
export TDAI_CODEX_TOOL_OFFLOAD_AGGRESSIVE_PREVIEW_CHARS=800
export TDAI_CODEX_TOOL_OFFLOAD_EMERGENCY_PREVIEW_CHARS=240
```

## Codex Host Notes

OpenClaw- or Claude Code-only interfaces such as host-specific slot APIs are not
applicable to Codex; this adapter uses Codex hook, MCP, JSONL history, and
context-injection surfaces instead. Codex can gate plugin-scoped hooks or omit
optional transcript fields in some builds; the adapter provides Codex-native
fallbacks through user-level hooks, local session state, tool-event summaries,
and history import.

## Security Notes

- Adapter-owned session state, gateway tokens, and offloaded tool-result files
  are written with private owner-only permissions on POSIX filesystems.
- Tokenized Gateways require `Authorization: Bearer ...` for all routes. A
  tokenless Gateway exposes only loopback `GET` probes by default; loopback
  tokenless `POST` routes require explicit development opt-in, and non-loopback
  tokenless access is rejected.
