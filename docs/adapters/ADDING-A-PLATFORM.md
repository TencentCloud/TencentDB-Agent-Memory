# Adding a New Platform in ~30 Lines

> Deliverable for [issue #235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235)
> (challenge tier: "a unified adapter SDK so a new platform only implements one
> interface"). This is the recipe the [`src/sdk`](../../src/sdk/README.md) SDK
> exists to make trivial.

## Mental model: two axes, one interface each

- **Consuming memory on a new platform** → consume a **`MemoryAdapter`** (you
  usually don't even implement it — a ready `GatewayMemoryAdapter` is provided).
  You just map `buildMemoryTools(adapter)` onto your host's tool type.
- **Reaching memory over a new backend/transport** → implement the
  **`MemoryAdapter`** interface once (e.g. an in-process `TdaiCore`), and every
  existing platform adapter keeps working unchanged.

Both are single, small interfaces — that is the whole point.

```
buildMemoryTools(adapter) ──► MemoryTool[] ──► (map to host tool type) ──► your platform
        ▲
   MemoryAdapter  ◄── GatewayMemoryAdapter (HTTP)  |  EmbeddedMemoryAdapter (in-process, DIY)
```

## The recipe (consume memory on a new platform)

### 1. Get an adapter

```ts
import { GatewayMemoryAdapter } from "../../sdk/index.js";

// Reads TDAI_GATEWAY_URL / TDAI_GATEWAY_API_KEY from the environment.
const adapter = GatewayMemoryAdapter.fromEnv();
```

### 2. Build the neutral tools

```ts
import { buildMemoryTools } from "../../sdk/index.js";

const tools = buildMemoryTools(adapter, { sessionKey: "my-platform-default" });
// → [{ name, title, description, inputSchema (JSON Schema), invoke(args) }, ...]
// invoke() never throws: failures come back as { isError: true, text }.
```

### 3. Map each tool onto your host

That mapping is the *entire* platform-specific surface. Two real examples:

#### Example A — Vercel AI SDK (`ai`, already a repo dependency)

```ts
import { tool, jsonSchema } from "ai";
import { GatewayMemoryAdapter, buildMemoryTools } from "../../sdk/index.js";

const adapter = GatewayMemoryAdapter.fromEnv();

export const memoryTools = Object.fromEntries(
  buildMemoryTools(adapter).map((t) => [
    t.name,
    tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (args) => (await t.invoke(args as Record<string, unknown>)).text,
    }),
  ]),
);
// Pass `memoryTools` straight to generateText({ tools: memoryTools, ... }).
```

#### Example B — any OpenAI-compatible function-calling loop

```ts
const tools = buildMemoryTools(GatewayMemoryAdapter.fromEnv());

// 1. Advertise them:
const functions = tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// 2. Dispatch a tool call the model emits:
async function runToolCall(name: string, argsJson: string): Promise<string> {
  const t = tools.find((x) => x.name === name);
  if (!t) return `Unknown tool: ${name}`;
  const { text } = await t.invoke(JSON.parse(argsJson));
  return text; // feed back as the tool/function result message
}
```

That is the whole integration — the SDK already handled the HTTP contract,
retries, auth, timeouts, argument coercion, and error shaping.

## The other axis (bring your own transport)

Need memory to come from somewhere other than the Gateway — say the in-process
`TdaiCore`, or a mock in tests? Implement the one interface and reuse every
platform adapter as-is:

```ts
import type { MemoryAdapter } from "../../sdk/index.js";

export class EmbeddedMemoryAdapter implements MemoryAdapter {
  readonly platform = "embedded";
  constructor(private core: /* TdaiCore */ any) {}

  async health()   { return { ok: true, status: "ok", degraded: false }; }
  async recall(i)  { const r = await this.core.handleBeforeRecall(i.query, i.sessionKey);
                     return { context: r.appendSystemContext ?? "", memoryCount: r.recalledL1Memories?.length ?? 0 }; }
  async searchMemories(i)       { return this.core.searchMemories(i); }
  async searchConversations(i)  { return this.core.searchConversations(i); }
  async capture(i) { const r = await this.core.handleTurnCommitted({ userText: i.userContent, assistantText: i.assistantContent, messages: i.messages ?? [], sessionKey: i.sessionKey });
                     return { l0Recorded: r.l0RecordedCount, schedulerNotified: r.schedulerNotified }; }
  async endSession(k) { await this.core.handleSessionEnd(k); }
}
```

`buildMemoryTools(new EmbeddedMemoryAdapter(core))` now yields the same tools the
MCP and Dify adapters use — with no HTTP hop.

## Checklist for a new platform PR

- [ ] Create `src/adapters/<platform>/` (code) or a schema (declarative).
- [ ] Reuse `GatewayMemoryAdapter` + `buildMemoryTools` — don't hand-roll HTTP.
- [ ] Map `MemoryTool` → the host's tool type (see examples above).
- [ ] Add a `README.md` with host config and a running-Gateway note.
- [ ] Add a test that drives your mapping against a fake adapter (see
      `src/adapters/mcp/protocol.test.ts` for the pattern).
- [ ] Link it from [`COMPARISON.md`](./COMPARISON.md) and the root README.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the pieces fit, and the
[`MCP`](../../src/adapters/mcp/README.md) / [`Dify`](../../src/adapters/dify/README.md)
adapters as end-to-end references.
