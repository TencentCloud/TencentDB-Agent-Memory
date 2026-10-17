import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../openai.js";
import type { AgentContextMetadata } from "../../types.js";

const metadata: AgentContextMetadata = {
  protocol: "openai",
  traceId: "fixture",
  keyId: "fixture",
  modelId: "fixture",
  stream: false,
  agentSource: "codebuddy",
};

function roundtrip(messages: Record<string, unknown>[]) {
  const adapter = new OpenAIAdapter();
  return adapter.serialize(adapter.parse({ messages }, metadata)).messages;
}

describe("OpenAI tool message content", () => {
  it("keeps an array of text parts as an array", () => {
    const messages = [
      { role: "tool", tool_call_id: "call_fixture", content: [{ type: "text", text: "result" }] },
    ];
    expect(roundtrip(messages)).toEqual(messages);
  });

  it("keeps string content unchanged", () => {
    const messages = [{ role: "tool", tool_call_id: "call_fixture", content: "result" }];
    expect(roundtrip(messages)).toEqual(messages);
  });

  it("sends rewritten text when an injector changes the result", () => {
    const adapter = new OpenAIAdapter();
    const ctx = adapter.parse(
      { messages: [{ role: "tool", tool_call_id: "c", content: [{ type: "text", text: "a" }] }] },
      metadata,
    );
    ctx.messages[0].blocks[0].content = "rewritten";
    expect(adapter.serialize(ctx).messages).toEqual([
      { role: "tool", tool_call_id: "c", content: "rewritten" },
    ]);
  });
});
