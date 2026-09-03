import { describe, expect, it } from "vitest";
import { AutoConversationRegistry } from "../auto-conversation.js";
import type { AutoConversationIdConfig } from "../../types.js";

const config: AutoConversationIdConfig = { enabled: true, ttlMinutes: 30, strategy: "per-key", maxEntries: 100 };
const first = (text: string) => [{ role: "user", content: text }];
const followup = (text: string) => [
  { role: "user", content: text },
  { role: "assistant", content: "calling tool" },
  { role: "tool", content: "result" },
];

describe("AutoConversationRegistry", () => {
  it("observes an explicit id and recovers it when tool calls lose headers", () => {
    const registry = new AutoConversationRegistry(() => 1_000);
    expect(registry.resolve({ explicitId: "client-session", keyScope: "key:openclaw", messages: first("hello"), config })).toBe("client-session");
    expect(registry.resolve({ explicitId: null, keyScope: "key:openclaw", messages: followup("hello"), config })).toBe("client-session");
  });

  it("does not rotate on an Anthropic-style user/tool_result continuation", () => {
    const registry = new AutoConversationRegistry(() => 1_000);
    registry.resolve({ explicitId: "client-session", keyScope: "key", messages: first("hello"), config });
    const id = registry.resolve({
      explicitId: null,
      keyScope: "key",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] }],
      config,
    });
    expect(id).toBe("client-session");
  });

  it("starts a new id for a genuinely new first message", () => {
    const registry = new AutoConversationRegistry(() => 1_000);
    const oldId = registry.resolve({ explicitId: null, keyScope: "key", messages: first("one"), config });
    const newId = registry.resolve({ explicitId: null, keyScope: "key", messages: first("two"), config });
    expect(newId).not.toBe(oldId);
  });

  it("expires an idle id at the configured TTL", () => {
    let now = 0;
    const registry = new AutoConversationRegistry(() => now);
    const oldId = registry.resolve({ explicitId: null, keyScope: "key", messages: first("same"), config });
    now = 30 * 60_000;
    const newId = registry.resolve({ explicitId: null, keyScope: "key", messages: followup("same"), config });
    expect(newId).not.toBe(oldId);
  });

  it("keeps multiple first-message partitions separate", () => {
    const registry = new AutoConversationRegistry(() => 1_000);
    const partitioned = { ...config, strategy: "per-key-msg" as const };
    const a = registry.resolve({ explicitId: null, keyScope: "key", messages: first("window A"), config: partitioned });
    const b = registry.resolve({ explicitId: null, keyScope: "key", messages: first("window B"), config: partitioned });
    const aAgain = registry.resolve({ explicitId: null, keyScope: "key", messages: followup("window A"), config: partitioned });
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a);
  });

  it("enforces the configured LRU capacity", () => {
    let now = 0;
    const registry = new AutoConversationRegistry(() => ++now);
    const bounded = { ...config, maxEntries: 2 };
    registry.resolve({ explicitId: null, keyScope: "a", messages: first("a"), config: bounded });
    registry.resolve({ explicitId: null, keyScope: "b", messages: first("b"), config: bounded });
    registry.resolve({ explicitId: null, keyScope: "c", messages: first("c"), config: bounded });
    expect(registry.size).toBe(2);
  });
});
