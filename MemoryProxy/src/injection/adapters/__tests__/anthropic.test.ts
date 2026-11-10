import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";

const meta = { protocol: "anthropic" } as unknown as AgentContextMetadata;
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

function bodyWithToolResult(content: unknown) {
  return {
    model: "m",
    max_tokens: 10,
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "look", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    ],
  };
}

function toolResultOf(body: Record<string, unknown>) {
  const msgs = body.messages as { content: Record<string, unknown>[] }[];
  return msgs[2].content[0];
}

describe("AnthropicAdapter tool_result round-trip", () => {
  const adapter = new AnthropicAdapter();

  it("keeps images nested in tool_result", () => {
    const content = [{ type: "text", text: "screenshot" }, image];
    const out = adapter.serialize(adapter.parse(bodyWithToolResult(content), meta));
    expect(toolResultOf(out).content).toEqual(content);
  });

  it("keeps image-only tool_result", () => {
    const content = [image];
    const out = adapter.serialize(adapter.parse(bodyWithToolResult(content), meta));
    expect(toolResultOf(out).content).toEqual(content);
  });

  it("keeps images when a hook rewrites the text", () => {
    const ctx = adapter.parse(bodyWithToolResult([{ type: "text", text: "a" }, image, { type: "text", text: "b" }]), meta);
    const block = ctx.messages[2].blocks[0];
    expect(block.content).toBe("a\nb");
    block.content = "rewritten";
    const out = adapter.serialize(ctx);
    expect(toolResultOf(out).content).toEqual([{ type: "text", text: "rewritten" }, image]);
  });

  it("text-only tool_result is serialized as before (plain string)", () => {
    const out = adapter.serialize(adapter.parse(bodyWithToolResult([{ type: "text", text: "x" }, { type: "text", text: "y" }]), meta));
    expect(toolResultOf(out).content).toBe("x\ny");
    const out2 = adapter.serialize(adapter.parse(bodyWithToolResult("plain"), meta));
    expect(toolResultOf(out2).content).toBe("plain");
  });
});
