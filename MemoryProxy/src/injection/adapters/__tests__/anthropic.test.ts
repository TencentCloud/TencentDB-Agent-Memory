import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";

describe("AnthropicAdapter tool lossless forwarding", () => {
  const adapter = new AnthropicAdapter();
  const mockMetadata: AgentContextMetadata = {
    protocol: "anthropic",
    traceId: "test",
    keyId: "test",
    modelId: "test",
    stream: false,
    agentSource: "test",
  };

  it("should losslessly forward a normal custom tool", () => {
    const rawTool = {
      name: "get_weather",
      description: "Get the current weather in a given location",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
        required: ["location"],
      },
      cache_control: { type: "ephemeral" },
    };

    const parsed = adapter.parse(
      { messages: [], tools: [rawTool] },
      mockMetadata,
    );

    expect(parsed.tools).toBeDefined();
    expect(parsed.tools?.length).toBe(1);

    const serialized = adapter.serialize(parsed);
    const outputTools = serialized.tools as unknown[];

    expect(outputTools).toBeDefined();
    expect(outputTools?.length).toBe(1);
    expect(outputTools![0]).toEqual(rawTool);
  });

  it("should losslessly forward an Anthropic server tool without hallucinating input_schema", () => {
    // Anthropic server tools omit input_schema and description but have extra fields
    const rawTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    };

    const parsed = adapter.parse(
      { messages: [], tools: [rawTool] },
      mockMetadata,
    );

    expect(parsed.tools).toBeDefined();
    expect(parsed.tools?.length).toBe(1);

    // Verify AgentTool structure represents it cleanly
    const tool = parsed.tools![0];
    expect(tool.name).toBe("web_search");
    expect(tool.description).toBeUndefined();
    expect(tool.parameters).toBeUndefined();
    expect(tool.custom).toBeDefined();
    expect(tool.custom?.type).toBe("web_search_20250305");
    expect(tool.custom?.max_uses).toBe(5);

    const serialized = adapter.serialize(parsed);
    const outputTools = serialized.tools as unknown[];

    expect(outputTools).toBeDefined();
    expect(outputTools?.length).toBe(1);
    expect(outputTools![0]).toEqual(rawTool);
    expect((outputTools![0] as any).input_schema).toBeUndefined();
  });
});
