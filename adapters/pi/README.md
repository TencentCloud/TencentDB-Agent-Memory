# TencentDB Agent Memory adapter for Pi

[简体中文](./README_CN.md)

A native [Pi](https://pi.dev/) extension that gives Pi persistent memory through
TencentDB Agent Memory. It uses Pi lifecycle events and tools directly; no MCP
bridge or session-file watcher is required.

## What it does

- Recalls L1 atomic memories before every agent run.
- Optionally adds bounded L2 scenario summaries and the L3 core profile.
- Captures the completed user/assistant turn to L0 after Pi fully settles.
- Exposes native Pi tools for explicit atomic-memory and conversation search.
- Uses the recommended v3 Team, Agent, and User isolation fields on every call.
- Fails open on timeout or MemoryCore outage, so Pi can keep working.
- Marks recalled data as untrusted and limits injected context size.
- Redacts common bearer, URL, private-key, and sensitive key/value patterns in
  recalled and explicit-search output.
- Bounds search queries and captured messages to the v3 gateway limits.
- Persists successful capture hashes as Pi session metadata to deduplicate
  repeated events across reloads without adding anything to model context.

## Architecture

~~~text
Pi before_agent_start
        |
        +--> POST /v3/atomic/search ---- L1 relevant memories
        +--> POST /v3/scenario/ls ------ L2 summaries (optional)
        +--> POST /v3/core/read -------- L3 profile (optional)
        |
        +--> bounded system-prompt context

Pi agent_end -> agent_settled
        |
        +--> POST /v3/conversation/add - L0 completed turn
~~~

The adapter never reads Pi session files and never writes TencentDB memory
storage directly. MemoryCore remains the only storage and extraction boundary.

## Requirements

- Node.js 22.19 or newer
- Pi 0.84.1 or newer
- A reachable TencentDB Agent Memory v3 Gateway
- A service ID, Team ID, Agent ID, User ID, and API key

See the repository [installation guide](../../INSTALL.md) to start MemoryCore.

## Install

From a clone of this repository:

~~~bash
pi install ./adapters/pi
~~~

For a project-local installation:

~~~bash
pi install -l ./adapters/pi
~~~

For a one-off local test without changing Pi settings:

~~~bash
pi -e ./adapters/pi/src/index.ts
~~~

Pi provides its extension runtime packages. This adapter declares them as peer
dependencies, as required by the Pi package format.

## Configure

Set the required environment variables before starting Pi:

~~~bash
export TDAI_MEMORY_ENDPOINT="http://127.0.0.1:8420"
export TDAI_MEMORY_API_KEY="your-api-key"
export TDAI_MEMORY_SERVICE_ID="your-memory-instance"
export TDAI_MEMORY_TEAM_ID="team-xxx"
export TDAI_MEMORY_AGENT_ID="agent-xxx"
export TDAI_MEMORY_USER_ID="user-xxx"

pi
~~~

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| TDAI_MEMORY_ENDPOINT | No | http://127.0.0.1:8420 | MemoryCore Gateway URL |
| TDAI_MEMORY_API_KEY | Yes | — | Bearer credential; never written to disk by the adapter |
| TDAI_MEMORY_SERVICE_ID | Yes | — | Memory instance sent as x-tdai-service-id |
| TDAI_MEMORY_TEAM_ID | Yes | — | v3 Team isolation |
| TDAI_MEMORY_AGENT_ID | Yes | — | v3 Agent isolation |
| TDAI_MEMORY_USER_ID | Yes | — | v3 User isolation |
| TDAI_MEMORY_TASK_ID | No | — | Optional v3 Task isolation |
| TDAI_PI_TIMEOUT_MS | No | 5000 | Per-request timeout, 100–60000 ms |
| TDAI_PI_RECALL_LIMIT | No | 5 | L1 matches, 1–20 |
| TDAI_PI_SCENARIO_LIMIT | No | 3 | L2 summaries, 0–20 |
| TDAI_PI_MAX_CONTEXT_CHARS | No | 8000 | Maximum recalled characters per run |
| TDAI_PI_INCLUDE_CORE | No | true | Include the L3 core profile |
| TDAI_PI_INCLUDE_SCENARIOS | No | true | Include L2 scenario summaries |
| TDAI_PI_ALLOW_INSECURE_HTTP | No | false | Allow bearer credentials over non-loopback HTTP |

Remote plain HTTP is rejected by default to avoid exposing bearer credentials.
For an explicitly trusted private network or Docker hostname, set
TDAI_PI_ALLOW_INSECURE_HTTP=1. HTTPS is preferred.

## Use

Automatic recall and capture work without prompting the model. The extension
also registers:

- tdai_memory_search — searches durable L1 atomic memories.
- tdai_conversation_search — searches raw L0 conversation evidence.
- /tdai-memory-status — checks authenticated v3 connectivity.

Pi session UUIDs become TencentDB session IDs with a pi: prefix. Automatic
recall searches across prior sessions within the configured Team, Agent, and
User boundary. The conversation-search tool can optionally restrict results to
the current Pi session.

## Verify

Start Pi, then run:

~~~text
/tdai-memory-status
~~~

After one completed conversation turn, verify L0 data through the SDK or API:

~~~bash
curl -sS "$TDAI_MEMORY_ENDPOINT/v3/conversation/query" \
  -H "Authorization: Bearer $TDAI_MEMORY_API_KEY" \
  -H "x-tdai-service-id: $TDAI_MEMORY_SERVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "'"$TDAI_MEMORY_TEAM_ID"'",
    "agent_id": "'"$TDAI_MEMORY_AGENT_ID"'",
    "user_id": "'"$TDAI_MEMORY_USER_ID"'",
    "limit": 10
  }'
~~~

## Development

~~~bash
cd adapters/pi
npm install --ignore-scripts
npm run check
npm run pack:check
~~~

The tests cover configuration safety, v3 request contracts, partial recall,
prompt-injection boundaries, lifecycle capture, deduplication, search tools, and
fail-open behavior.

## Known boundaries

- The adapter does not create Team, Agent, or User records. Create them in
  Memory Hub first and pass their IDs through the environment.
- L2 currently uses the bounded summaries returned by scenario listing because
  the v3 data plane has no semantic scenario-search endpoint.
- Successful captures are deduplicated across Pi reloads through non-context
  session entries. An ambiguous network failure after the server writes but
  before the response arrives can still duplicate a turn because the current
  conversation-add endpoint assigns its own message IDs.
- Recalled memory is model context, not authorization. Isolation and access
  control remain the responsibility of MemoryCore.
- The v3 gateway limits search queries to 2048 characters and each conversation
  message to 8192 characters; the adapter truncates at that boundary.

## References

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)

## License

MIT, consistent with the parent repository.
