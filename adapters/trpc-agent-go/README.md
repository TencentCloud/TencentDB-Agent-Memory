# TencentDB Agent Memory — trpc-agent-go Adapter

Give agents built with [trpc-agent-go](https://github.com/trpc-group/trpc-agent-go) persistent memory, backed by TencentDB Agent Memory. trpc-agent-go ships a first-party integration package, `memory/tencentdb`, and this adapter directory provides the quickstart, wiring guide, and a runnable example for connecting it to a TencentDB Agent Memory deployment.

Once wired in, every session automatically gets:

- **Turn capture** — each completed user/assistant turn is streamed to the gateway (`POST /capture`) and enters the L0 → L3 memory pipeline
- **Automatic recall** *(opt-in)* — relevant memory context is injected before each model call (`POST /recall`)
- **Retrieval tools** — `tdai_conversation_search` (session-scoped, on by default) and `tdai_memory_search` (long-term, opt-in) let the model actively look things up
- **Optional context offload v2** — large tool results can be offloaded and compacted by the gateway

## How it works

```
trpc-agent-go Runner
  ├─ session.Ingestor ──(POST /capture)───────┐
  ├─ recall plugin ────(POST /recall)─────────┤
  └─ tdai_* tools ─────(POST /search/*)───────┤
                                              ▼
                     Memory Core Gateway (port 8420)
                                 │
                          L0 → L3 memory pipeline
                    (capture · extract · store · recall)
```

The adapter talks to the **memory-core gateway** (`:8420` by default), which runs the memory engine. This is a framework-level integration: Go developers import `trpc.group/trpc-go/trpc-agent-go/memory/tencentdb` and keep full control of Runner, Session, Plugin, and Tool lifecycles. It is distinct from the OpenAI-compatible proxy (`:8096`) that coding-agent clients such as OpenCode use.

## Prerequisites

1. TencentDB Agent Memory is running locally:

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   Set `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` in `.env` — the memory engine uses this LLM for extraction, summarization, and recall. The gateway listens on `MEMORY_CORE_PORT` (default `8420`).

2. Go 1.21+ and trpc-agent-go **v1.11.1 or later** (the `memory/tencentdb` package is included upstream):

   ```bash
   go get trpc.group/trpc-go/trpc-agent-go@v1.11.1
   ```

3. An OpenAI-compatible API key for your agent's own chat model (the example reads `OPENAI_API_KEY`).

## Run the example

```bash
cd adapters/trpc-agent-go/example
export OPENAI_API_KEY="sk-..."          # the agent's chat model
go run . -model deepseek-chat           # or your provider's model name
```

Then verify memory across sessions:

```text
You: Remember: my project codename is Apollo Lake, deploy window is Friday night.
You: /new
You: What is my project codename and deploy window?
```

The first turn is captured by the gateway; `/new` flushes the session and starts a fresh one; the follow-up question should be answered from recalled memory (give the pipeline a few seconds to extract, or keep the default `-turn-wait`).

## Wiring into your own project

```go
import (
    memorytencentdb "trpc.group/trpc-go/trpc-agent-go/memory/tencentdb"
    "trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
    "trpc.group/trpc-go/trpc-agent-go/model/openai"
    "trpc.group/trpc-go/trpc-agent-go/runner"
    sessioninmemory "trpc.group/trpc-go/trpc-agent-go/session/inmemory"
)

memSvc, err := memorytencentdb.NewService(
    memorytencentdb.WithGatewayURL("http://127.0.0.1:8420"),
    // Opt-in: these read the gateway's shared long-term store. Enable them
    // only when the gateway enforces per-tenant isolation (fine for a local,
    // single-user sidecar).
    memorytencentdb.WithRecallEnabled(true),
    memorytencentdb.WithMemorySearchTool(true),
)
if err != nil {
    return err
}
defer memSvc.Close()

agent := llmagent.New(
    "assistant",
    llmagent.WithModel(openai.New("deepseek-chat")),
    llmagent.WithTools(memSvc.Tools()),      // tdai_* retrieval tools
)

r := runner.NewRunner(
    "my-app",
    agent,
    runner.WithSessionService(sessioninmemory.NewSessionService()),
    runner.WithSessionIngestor(memSvc),      // streams turns to /capture
    runner.WithPlugins(memSvc.Plugin()),     // auto recall before model calls
)
defer r.Close()
```

Do **not** use `runner.WithMemoryService(...)` with this integration — the gateway owns the memory semantics; the adapter surface is `Ingestor` + `Plugin` + `Tools`.

## Configuration reference

| Option | Effect | Default |
|---|---|---|
| `WithGatewayURL(url)` | Memory-core gateway URL. | `http://127.0.0.1:8420` |
| `WithAPIKey(key)` | Sends `Authorization: Bearer <key>`; required when the gateway starts with `TDAI_GATEWAY_API_KEY`. | none |
| `WithTimeout(d)` | Gateway HTTP client timeout. | `5s` |
| `WithRecallEnabled(bool)` | Automatic recall plugin (opt-in; reads shared store). | `false` |
| `WithMemorySearchTool(bool)` | Expose `tdai_memory_search` (opt-in; reads shared store). | `false` |
| `WithConversationSearchTool(bool)` | Expose session-scoped `tdai_conversation_search`. | `true` |
| `WithStandardAliases(bool)` | Also expose the standard `memory_search` alias. | `false` |
| `WithToolPrefix(p)` | Prefix for native tool names. | `tdai` |
| `WithIngestWorkers(n)` / `WithIngestQueueSize(n)` / `WithIngestJobTimeout(d)` | Async capture pipeline tuning. | `1` / `10` / `30s` |
| `WithSessionKeyFunc(fn)` | Custom session → gateway `session_key` mapping. | `base64url(app):base64url(user):base64url(session)` |
| `WithContextOffload(cfg)` | Explicit short-term context offload v2 (requires `ServiceID`; see upstream docs). | disabled |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `gateway is not ready` on startup | The stack is not running — start it with `deploy/global-images/start-all.sh` and check `MEMORY_CORE_PORT`; verify with `curl http://127.0.0.1:8420/health`. |
| Gateway returns `401` | The gateway was started with an API key — pass the same value via `WithAPIKey(...)`. |
| Model never calls memory tools | Tools were not registered on the agent — add `llmagent.WithTools(memSvc.Tools())`. |
| No memory recalled in new sessions | `WithRecallEnabled(true)` missing; or extraction is still running (it is asynchronous — retry after a few seconds). |
| Turns never reach the gateway | `runner.WithSessionIngestor(memSvc)` missing, or the session has an empty app/user/session ID (all three are required). |
| Cross-user memory leakage concerns | Disable `WithRecallEnabled` and `WithMemorySearchTool` unless the gateway guarantees per-tenant isolation; session-scoped capture and conversation search stay safe. |

## Testing

The example ships with a smoke test that exercises the adapter wiring against a fake gateway (health probe, tool exposure, capture payload, session flush, bearer auth) — no stack or LLM required:

```bash
cd adapters/trpc-agent-go/example
go test ./...
```

## Notes

- **Version**: verified with trpc-agent-go `v1.11.1` and TencentDB Agent Memory v2 images (`feat/server_team` branch).
- **Upstream docs**: full option semantics, context offload v2 behavior, and multi-tenant guidance live in the trpc-agent-go repository (`docs/mkdocs` → memory → tencentdb) and in `examples/memory/tencentdb`.
- **Data flow**: only transcript turns and retrieval queries transit the gateway; memory data stays in your local storage (SQLite by default) unless configured otherwise.

## License

MIT, same as the main repository.
