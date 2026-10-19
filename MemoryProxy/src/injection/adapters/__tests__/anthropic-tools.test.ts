import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic", traceId: "test", keyId: "test", modelId: "test",
  stream: false, agentSource: "claude-code",
};

describe("Anthropic tool round-trip", () => {
  it("preserves the server tool appended by Claude Code after its custom tools", () => {
    const tools = [
      ...Array.from({ length: 181 }, (_, i) => ({
        name: `tool_${i}`, description: "Custom tool",
        input_schema: { type: "object", properties: {} }, defer_loading: true,
      })),
      { type: "advisor_20260301", name: "advisor", model: "claude-fable-5-1", defer_loading: true },
    ];
    const adapter = new AnthropicAdapter();
    const body = { messages: [{ role: "user", content: "hi" }], tools };
    const result = adapter.serialize(adapter.parse(body, metadata));
    expect(result.tools).toEqual(tools);
    expect((result.tools as Record<string, unknown>[])[181]).not.toHaveProperty("input_schema");
  });

  it("serializes injected custom tools and keeps changes to parsed custom tools", () => {
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse({ tools: [{ name: "read", input_schema: { type: "object" }, strict: true }] }, metadata);
    ctx.tools![0].parameters = { type: "object", properties: { path: { type: "string" } } };
    ctx.tools!.push({ name: "injected", description: "Injected tool", parameters: { type: "object" } });
    expect(adapter.serialize(ctx).tools).toEqual([
      { name: "read", description: "", input_schema: ctx.tools![0].parameters, strict: true },
      { name: "injected", description: "Injected tool", input_schema: { type: "object" } },
    ]);
  });
});
