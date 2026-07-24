# @tencentdb-agent-memory/memory-sdk-ts

TypeScript SDK for the **TencentDB Agent Memory v2 API**.

## Install

```bash
# From npm (after publish)
npm install @tencentdb-agent-memory/memory-sdk-ts

# From local .tgz
npm install ./tencentdb-agent-memory-memory-sdk-0.1.0.tgz
```

## Quick Start

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const client = new MemoryClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: "your-api-key",
  serviceId: "your-memory-space-id",
});

// L0: append a conversation
const result = await client.addConversation({
  session_id: "sess-1",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ],
});
console.log(result.accepted_ids);

// L1: search structured memories
const hits = await client.searchAtomic({ query: "user preferences", limit: 5 });
console.log(hits.items);

// L1: update a memory note
await client.updateAtomic({ id: "note-xxx", content: "updated content", background: "context" });

// L2: list scenario files
const scenarios = await client.listScenarios({ path_prefix: "" });
console.log(scenarios.entries);

// L2: read a scenario file
const file = await client.readScenario({ path: "工作.md" });
console.log(file.content);

// L2: update a scenario file (must already exist)
await client.writeScenario({ path: "工作.md", content: "# Updated", summary: "new summary" });

// L3: read core memory (persona)
const core = await client.readCore();
console.log(core.content);

// L3: write core memory
await client.writeCore({ content: "# User Profile\n..." });

// Offload v2: send tool pairs for server-side L1 async processing (fire-and-forget)
await client.offloadIngest({
  session_id: "agent_sess_123",
  tool_pairs: [
    { tool_name: "search", tool_call_id: "call_1", params: { q: "..." }, result: "...", timestamp: "..." },
  ],
});

// Offload v2: server-side context compaction (sync wait for result)
const compacted = await client.offloadCompact({
  session_id: "agent_sess_123",
  messages: [...],
  ratio: 0.7,
  context_window: 128000,
  total_tokens: 160000,
});
console.log(compacted.messages, compacted.report);

// Recover an archived tool result referenced by a compacted message
const ref = await client.offloadReadRef({
  session_id: "agent_sess_123",
  result_ref: "offload/agent_sess_123/refs/call_1.md",
  query: "relevant section",
  max_tokens: 800,
});
console.log(ref.content, ref.truncated);

// Offload v2: query MMD task graphs
const mmd = await client.offloadQueryMmd({ session_id: "agent_sess_123", limit: 1 });
console.log(mmd.current_mmd, mmd.mmds);

// Read memory pipeline artifacts (e.g. persona.md, scene_blocks/*.md)
const raw = await client.readFile("scene_blocks/工作.md");
```

## API Methods

| Layer | Method | Endpoint |
|-------|--------|----------|
| L0 | `addConversation()` | `POST /v2/conversation/add` |
| L0 | `queryConversation()` | `POST /v2/conversation/query` |
| L0 | `searchConversation()` | `POST /v2/conversation/search` |
| L0 | `deleteConversation()` | `POST /v2/conversation/delete` |
| L1 | `updateAtomic()` | `POST /v2/atomic/update` |
| L1 | `queryAtomic()` | `POST /v2/atomic/query` |
| L1 | `searchAtomic()` | `POST /v2/atomic/search` |
| L1 | `deleteAtomic()` | `POST /v2/atomic/delete` |
| L2 | `listScenarios()` | `POST /v2/scenario/ls` |
| L2 | `readScenario()` | `POST /v2/scenario/read` |
| L2 | `writeScenario()` | `POST /v2/scenario/write` |
| L2 | `rmScenario()` | `POST /v2/scenario/rm` |
| L3 | `readCore()` | `POST /v2/core/read` |
| L3 | `writeCore()` | `POST /v2/core/write` |
| Offload | `offloadIngest()` | `POST /v2/offload/ingest` |
| Offload | `offloadCompact()` | `POST /v2/offload/compact` |
| Offload | `offloadReadRef()` | `POST /v2/offload/read-ref` |
| Offload | `offloadQueryMmd()` | `POST /v2/offload/query-mmd` |

## Error Handling

All non-zero `code` responses throw `TDAMError`:

```typescript
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts";

try {
  await client.readCore();
} catch (e) {
  if (e instanceof TDAMError) {
    console.error(`code=${e.code} message=${e.message} request_id=${e.requestId}`);
  }
}
```

## Build & Pack

```bash
# Build
npm run build

# Pack as .tgz for distribution
npm pack
# → tencentdb-agent-memory-memory-sdk-0.1.0.tgz
```

## License

MIT
