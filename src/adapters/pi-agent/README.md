# Pi Agent Adapter

This adapter maps Pi Agent Extension lifecycle events and custom tools to the existing TencentDB-Agent-Memory Gateway.

The adapter is intentionally separate from `src/adapters/claude-code/`:

- Claude Code uses hooks plus MCP.
- Pi Agent v1 uses Pi Extension lifecycle events plus custom tool definitions.
- Pi Agent v1 does not copy Claude Code short-term canvas/offload internals; `tool_result` and `context_get` are reserved for the next stage.
- Pi Agent memory keys use the `pi-agent:` prefix, so Pi sessions do not collide with Claude Code sessions.

## Current v1 scope

Supported:

- `before_agent_start` -> Gateway `/recall` -> returns a Pi custom message containing recalled memory context
- `session_shutdown` -> Gateway `/seed` + `/session/end`
- `memory_search` custom tool -> Gateway `/search/memories`
- `conversation_search` custom tool -> Gateway `/search/conversations`
- `context_get` custom tool -> reserved response explaining that short-term context is not implemented in v1

Compatibility aliases are kept for the earlier draft names `session_start` and `session_end`, but the default extension registration follows the official Pi lifecycle names.

Not included yet:

- tool trajectory persistence
- short-term context offload/compression
- automatic Pi-specific context restore

## Usage sketch

```ts
import registerPiAgentMemoryExtension from "@tencentdb-agent-memory/memory-tencentdb/src/adapters/pi-agent";

export default function register(pi) {
  registerPiAgentMemoryExtension(pi, {
    config: {
      gatewayUrl: "http://127.0.0.1:8420",
    },
  });
}
```

The adapter expects the Pi Extension runtime shape:

```ts
pi.on("before_agent_start", handler);
pi.on("session_shutdown", handler);
pi.on("tool_result", handler);
pi.registerTool({ name: "memory_search", parameters, execute });
pi.registerTool({ name: "conversation_search", parameters, execute });
pi.registerTool({ name: "context_get", parameters, execute });
```

## Environment

```text
MEMORY_TENCENTDB_PI_GATEWAY_URL=http://127.0.0.1:8420
MEMORY_TENCENTDB_PI_GATEWAY_API_KEY=
MEMORY_TENCENTDB_PI_AUTO_RECALL=true
MEMORY_TENCENTDB_PI_AUTO_CAPTURE=true
MEMORY_TENCENTDB_PI_RECALL_MAX_CHARS=4000
MEMORY_TENCENTDB_PI_USER_ID=default_user
```

The generic `MEMORY_TENCENTDB_GATEWAY_URL`, `MEMORY_TENCENTDB_GATEWAY_API_KEY`, and `TDAI_GATEWAY_API_KEY` variables are accepted as fallbacks.

## Design boundary

Pi Agent v1 proves the lifecycle loop:

```text
Pi before_agent_start -> recall -> custom memory message
Pi session_shutdown   -> seed/capture -> session end
Pi tools              -> memory/conversation search
```

Short-term memory should be designed as a Pi-native follow-up instead of reusing Claude Code's canvas/offload files directly.