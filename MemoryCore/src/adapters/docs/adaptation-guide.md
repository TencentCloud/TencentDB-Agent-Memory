# Platform Adaptation Guide

> How to create a new platform adapter for the TDAI memory system.

This guide walks through the process of integrating a new Agent platform with
the TDAI memory engine using the Unified Adapter SDK. Whether your platform is
written in TypeScript or Python, the steps are identical.

## Prerequisites

- A running TDAI Gateway (default: `http://127.0.0.1:8420`)
- Node.js 18+ (for TypeScript adapters) or Python 3.10+ (for Python adapters)
- Basic familiarity with the host platform's hook / plugin / extension API

## The 4-Method Contract

Every platform adapter must implement exactly 4 abstract methods. The base
class handles everything else (Gateway I/O, circuit breaking, error handling,
health checks):

| Method | Purpose | When called |
|--------|---------|-------------|
| `formatRecallResult(result)` | Convert recall data into the host's prompt-injection format | During `recall()`, after Gateway fetch |
| `getToolDefinitions()` | Return tool schemas the host registers with its LLM | During adapter initialization / tool registration |
| `formatToolResult(toolName, rawResult)` | Format a tool call's output for the host's response convention | During `handleToolCall()`, after Gateway search |
| `normalizeMessages(rawMessages, context?)` | Convert the host's conversation format into standard `ConversationMessage[]` | During `capture()`, before Gateway write |

## Step-by-Step: TypeScript Adapter

### Step 1: Create the adapter file

```
src/adapters/my-platform/
├── adapter.ts      # MyPlatformAdapter class
├── index.ts        # Barrel exports
└── README.md       # Platform-specific docs
```

### Step 2: Extend `MemoryAdapterBase`

```typescript
import { MemoryAdapterBase } from "../sdk/base-adapter.js";
import type {
  AdapterConfig,
  ConversationMessage,
  RecallResult,
  SearchResult,
  ToolDefinition,
} from "../sdk/types.js";

export class MyPlatformAdapter extends MemoryAdapterBase {
  readonly platformName = "my-platform";

  // Implement 4 abstract methods (see below)
}
```

### Step 3: Implement `formatRecallResult`

This method receives the raw recall data (L1 memories, L3 persona, L2 scenes)
and returns two strings:

- `prependContext` — injected **before** the user's latest message (dynamic,
  changes every turn). Typically L1 relevant memories.
- `appendSystemContext` — appended to the **system prompt** (stable,
  cacheable across turns). Typically L3 persona + L2 scene navigation.

```typescript
formatRecallResult(result: RecallResult): {
  prependContext?: string;
  appendSystemContext?: string;
} {
  const parts: { prependContext?: string; appendSystemContext?: string } = {};

  // L1 memories → prependContext (dynamic, per-turn)
  if (result.memories.length > 0) {
    const lines = result.memories.map((m) =>
      `- [${m.type}] ${m.content}` +
      (typeof m.score === "number" ? ` (score: ${m.score.toFixed(2)})` : "")
    );
    parts.prependContext =
      `<memories>\n${lines.join("\n")}\n</memories>`;
  }

  // L3 persona → appendSystemContext (stable)
  if (result.persona) {
    parts.appendSystemContext =
      `<persona>\n${result.persona.content}\n</persona>`;
  }

  // L2 scenes → appendSystemContext (stable)
  if (result.scenes.length > 0) {
    const sceneLines = result.scenes.map(
      (s) => `- ${s.path}${s.summary ? ` — ${s.summary}` : ""}`,
    );
    parts.appendSystemContext =
      (parts.appendSystemContext || "") +
      `\n<scenes>\n${sceneLines.join("\n")}\n</scenes>`;
  }

  return parts;
}
```

### Step 4: Implement `getToolDefinitions`

Return the tool schemas your platform's LLM expects. The three standard tools
are `memory_search`, `conversation_search`, and `read_scene`, but you can
customize names, descriptions, and parameter schemas:

```typescript
getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "tdai_memory_search",
      label: "Memory Search",
      description:
        "Search structured long-term memories. Use when you need to " +
        "recall something discussed previously.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query.",
          },
          limit: {
            type: "number",
            description: "Max results (default: 5).",
          },
        },
        required: ["query"],
      },
    },
    // ... conversation_search, read_scene ...
  ];
}
```

### Step 5: Implement `formatToolResult`

Format the raw search result (from `searchMemories()`, `searchConversations()`,
or `readScene()`) into a string the host platform can display to the LLM:

```typescript
formatToolResult(
  toolName: string,
  rawResult: SearchResult | string,
): string {
  if (typeof rawResult === "string") {
    return rawResult; // Scene content is already a string
  }

  // Format memory/conversation search results
  if (rawResult.items.length === 0) {
    return "No results found.";
  }

  const lines = rawResult.items.map((m) =>
    `- [${m.type}] ${m.content}`,
  );
  return lines.join("\n");
}
```

### Step 6: Implement `normalizeMessages`

Convert your platform's conversation format into the standard
`ConversationMessage[]` shape. This is the most platform-specific method:

```typescript
normalizeMessages(
  rawMessages: unknown,
  context?: Record<string, unknown>,
): ConversationMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: ConversationMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;

    const role = this._normalizeRole((raw as any).role);
    if (!role) continue; // Skip unknown roles

    const content = this._extractContent((raw as any).content);
    if (!content) continue;

    messages.push({
      role,
      content,
      timestamp: (raw as any).timestamp || new Date().toISOString(),
    });
  }

  return messages;
}

private _normalizeRole(
  raw: string | undefined,
): ConversationMessage["role"] | null {
  switch (raw?.toLowerCase()) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "ai":
    case "bot":
      return "assistant";
    case "system":
    case "developer":
      return "system";
    case "tool":
    case "function":
      return "tool";
    default:
      return null;
  }
}

private _extractContent(
  content: unknown,
): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.text) return block.text;
        return null;
      })
      .filter(Boolean)
      .join("\n") || null;
  }
  return null;
}
```

### Step 7: Create a factory and barrel export

```typescript
// index.ts
export { MyPlatformAdapter } from "./adapter.js";

// Optional: factory function with env-based config
export async function createMyPlatformAdapter(
  config?: Partial<AdapterConfig>,
): Promise<MyPlatformAdapter> {
  const adapter = new MyPlatformAdapter();
  const resolved = adapter.resolveConfig(config);
  await adapter.initialize(resolved);
  return adapter;
}
```

### Step 8: Use the adapter

```typescript
import { createMyPlatformAdapter } from "./adapters/my-platform/index.js";

// Initialize (reads env vars, with optional overrides)
const adapter = await createMyPlatformAdapter({
  gateway: { endpoint: "http://localhost:8420" },
  tenancy: { userId: "alice" },
});

// Recall memories before generating a response
const { prependContext, appendSystemContext } =
  await adapter.recall("What did we discuss about React?", "session-1");

// Capture the conversation after the response
await adapter.capture(messages, "session-1");

// Handle tool calls from the LLM
const result = await adapter.handleToolCall("tdai_memory_search", {
  query: "user preferences",
});

// Clean up
await adapter.shutdown();
```

## Step-by-Step: Python Adapter

The Python SDK mirrors the TypeScript SDK exactly. Use it for Python-based
platforms like Dify or Hermes.

### Step 1: Create the adapter file

```
my_platform/
├── __init__.py
├── adapter.py       # MyPlatformAdapter class
├── types.py         # (optional) platform-specific types
└── README.md
```

### Step 2: Extend `MemoryAdapterBase`

```python
from .base_adapter import MemoryAdapterBase
from .types import (
    AdapterConfig,
    ConversationMessage,
    FormattedRecallResult,
    RecallResult,
    SearchResult,
    ToolDefinition,
)

class MyPlatformAdapter(MemoryAdapterBase):
    """Adapter for My Platform."""

    platform_name = "my-platform"

    # Implement 4 abstract methods (same contract as TypeScript)
```

### Step 3: Implement the 4 methods

The method signatures are snake_case but otherwise identical:

```python
def format_recall_result(self, result: RecallResult) -> FormattedRecallResult:
    prepend_parts: List[str] = []
    append_parts: List[str] = []

    if result.memories:
        lines = [f"- [{m.type}] {m.content}" for m in result.memories]
        prepend_parts.append(
            "<relevant-memories>\n" + "\n".join(lines) + "\n</relevant-memories>"
        )

    if result.persona:
        append_parts.append(
            f"<user-persona>\n{result.persona.content}\n</user-persona>"
        )

    if result.scenes:
        scene_lines = [
            f"- {s['path']}" + (f" — {s['summary']}" if s.get("summary") else "")
            for s in result.scenes
        ]
        append_parts.append(
            "<scene-navigation>\n" + "\n".join(scene_lines) + "\n</scene-navigation>"
        )

    return FormattedRecallResult(
        prepend_context="\n\n".join(prepend_parts) if prepend_parts else "",
        append_system_context="\n\n".join(append_parts) if append_parts else "",
    )

def get_tool_definitions(self) -> List[ToolDefinition]:
    return [
        ToolDefinition(
            name="tdai_memory_search",
            label="Memory Search",
            description="Search structured long-term memories.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query."},
                },
                "required": ["query"],
            },
        ),
        # ... conversation_search, read_scene ...
    ]

def format_tool_result(
    self,
    tool_name: str,
    raw_result: Union[SearchResult, str],
) -> str:
    if isinstance(raw_result, str):
        return raw_result
    if not raw_result.items:
        return "No results found."
    return "\n".join(f"- [{m.type}] {m.content}" for m in raw_result.items)

def normalize_messages(
    self,
    raw_messages: Any,
    context: Optional[Dict[str, Any]] = None,
) -> List[ConversationMessage]:
    if not isinstance(raw_messages, list):
        return []

    messages: List[ConversationMessage] = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        role = self._normalize_role(raw.get("role", ""))
        if not role:
            continue
        content = self._extract_content(raw.get("content"))
        if not content:
            continue
        messages.append(ConversationMessage(
            role=role,
            content=content,
            timestamp=raw.get("timestamp", datetime.now(timezone.utc).isoformat()),
        ))
    return messages
```

### Step 4: Initialize and use

```python
from my_platform.adapter import MyPlatformAdapter

adapter = MyPlatformAdapter()
adapter.initialize({
    "gateway": {"endpoint": "http://127.0.0.1:8420"},
    "tenancy": {"team_id": "my-team", "user_id": "alice"},
})

# Recall
prepend, append = adapter.recall("What did we discuss?", "session-1")

# Capture
adapter.capture(messages, "session-1")

# Tool call
result = adapter.handle_tool_call("tdai_memory_search", {"query": "preferences"})

# Shutdown
adapter.shutdown()
```

## Testing Your Adapter

### Unit test skeleton (TypeScript)

```typescript
import { describe, it, expect, vi } from "vitest";
import { MyPlatformAdapter } from "./adapter.js";

describe("MyPlatformAdapter", () => {
  const adapter = new MyPlatformAdapter();

  describe("formatRecallResult", () => {
    it("should format memories as XML blocks", () => {
      const result = adapter.formatRecallResult({
        prependContext: "",
        appendSystemContext: "",
        memories: [
          { type: "episodic", content: "User likes TypeScript", score: 0.9 },
        ],
        persona: null,
        scenes: [],
        latencyMs: 42,
      });

      expect(result.prependContext).toContain("[episodic]");
      expect(result.prependContext).toContain("User likes TypeScript");
    });

    it("should return empty strings when no data", () => {
      const result = adapter.formatRecallResult({
        prependContext: "",
        appendSystemContext: "",
        memories: [],
        persona: null,
        scenes: [],
        latencyMs: 0,
      });

      expect(result.prependContext).toBeUndefined();
      expect(result.appendSystemContext).toBeUndefined();
    });
  });

  describe("normalizeMessages", () => {
    it("should normalize role variations", () => {
      const messages = adapter.normalizeMessages([
        { role: "human", content: "Hello" },
        { role: "ai", content: "Hi there" },
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });
  });
});
```

### Integration test checklist

- [ ] Adapter initializes successfully with valid Gateway endpoint
- [ ] `recall()` returns non-empty `prependContext` when memories exist
- [ ] `recall()` returns empty strings when Gateway is unreachable (no throw)
- [ ] `capture()` records messages and returns `success: true`
- [ ] `handleToolCall("tdai_memory_search", ...)` returns formatted results
- [ ] Circuit breaker opens after 5 consecutive failures
- [ ] Circuit breaker recovers after 60-second cooldown

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Throwing errors from abstract methods | All methods must return empty results on failure. Use try/catch internally. |
| Hardcoding Gateway endpoint | Always read from env vars first, allow programmatic override. |
| Forgetting to normalize timestamps | If the host doesn't provide timestamps, use `new Date().toISOString()`. |
| Not handling multi-modal content | Content may be an array of blocks — extract text from all block types. |
| Skipping unknown roles | Unknown roles should be silently skipped, not logged as errors. |
| Over-fetching in recall | The base class already does parallel L1+L3+L2 fetch. Don't add extra Gateway calls in `formatRecallResult`. |
