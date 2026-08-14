# TencentDB Agent Memory — Pi Adapter

A [Pi coding agent](https://github.com/earendil-works/pi) extension that gives Pi persistent, cross-session memory backed by the TDAI Memory Gateway.

**Adapter lane** (per [`docs/adapters/contribution-guide.md`](../../docs/adapters/contribution-guide.md)): coding-agent adapter. Talks to the existing Gateway HTTP API; does not add platform SDK dependencies to core.

## How it works

```
┌────────────────────── Pi (TUI / print / RPC) ──────────────────────┐
│                                                                    │
│  user prompt                                                       │
│    │                                                               │
│    ├─ before_agent_start ──► POST /recall ──► inject memories      │
│    │                          as a custom context message          │
│    ▼                                                               │
│  LLM turn(s)…  ── may call memory_search ──► POST /search/memories │
│    │                                                               │
│    ├─ agent_end ───────────► POST /capture (user + assistant round)│
│    │                          Gateway archives L0, schedules L1    │
│    ▼                          extraction asynchronously            │
│  session exit / switch ────► POST /session/end (flush)             │
└────────────────────────────────────────────────────────────────────┘
                     TDAI Gateway (standalone sidecar, port 8420)
```

- **Recall**: before each agent run, memories relevant to the prompt are fetched and injected into LLM context (hidden by default; the current conversation is instructed to take precedence on conflict).
- **Capture**: after each run, the user/assistant round is archived (L0) and structured facts are extracted asynchronously (L1) by the Gateway's pipeline.
- **Explicit search**: a `memory_search` tool lets the LLM proactively query long-term memories.
- **Session identity**: `session_key` is `pi_<sessionId>` from Pi's SessionManager — stable across `/resume` of the same session file, distinct across `/new`.

## Setup

### 1. Start the Gateway

```bash
cd TencentDB-Agent-Memory
TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
TDAI_LLM_API_KEY="sk-..." \
TDAI_LLM_MODEL="deepseek-chat" \
node --import tsx/esm src/gateway/server.ts
```

Any OpenAI-compatible chat endpoint works for L1/L2/L3 extraction. See the repository README for full Gateway configuration (embedding service, hybrid recall, auth, etc.).

### 2. Install the extension

Copy (or symlink) this directory into Pi's extension path:

```bash
# global (all projects)
cp -r pi-plugin/tdai-memory ~/.pi/agent/extensions/

# or project-local
cp -r pi-plugin/tdai-memory .pi/extensions/
```

For a quick trial without installing:

```bash
pi -e pi-plugin/tdai-memory/index.ts
```

### 3. Configure (optional)

| Environment variable | Default | Purpose |
| :--- | :--- | :--- |
| `MEMORY_TENCENTDB_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `MEMORY_TENCENTDB_GATEWAY_API_KEY` | (unset) | Bearer token when the Gateway sets `TDAI_GATEWAY_API_KEY` |
| `MEMORY_TENCENTDB_TIMEOUT_MS` | `5000` | Per-request timeout |
| `MEMORY_TENCENTDB_RECALL_DISPLAY` | (hidden) | `1` to render recalled memories in the TUI |

## Fault tolerance

Every Gateway call is best-effort: when the Gateway is down, recall injection is skipped (one warning per session), capture is dropped, and `memory_search` reports the outage to the LLM instead of throwing. Pi never breaks because memory is unavailable — mirroring the degradation philosophy of the core plugin.

## Verified flow

Tested end-to-end with `pi 0.80.8` + DeepSeek:

1. Session A: "我叫小明，最喜欢的编程语言是 Rust，在研究 Hopfield 网络" → `/capture` recorded L0, Gateway extracted 2 L1 memories (persona + episodic).
2. Session B (fresh process): "我最喜欢的编程语言是什么？" → `/recall` injected the memories; Pi answered "Rust … Hopfield 网络记忆容量" correctly.
3. `memory_search` tool: callable by the LLM, returns formatted memory list.
4. Gateway stopped: Pi still answers normally, exit code 0, one-line warning.

## Files

| File | Purpose |
| :--- | :--- |
| `index.ts` | Extension entry — lifecycle hooks + `memory_search` tool |
| `gateway-client.ts` | Dependency-free typed HTTP client for the Gateway API |
| `capture-utils.ts` | Pure round-extraction helpers (unit-tested without the Pi runtime) |

Unit tests live in [`__tests__/pi-plugin/`](../../__tests__/pi-plugin/) and run with the repository's standard `npm test`.
