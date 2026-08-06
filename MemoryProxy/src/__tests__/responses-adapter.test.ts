import { describe, expect, it } from "vitest";
import { ResponsesAdapter } from "../injection/adapters/responses.js";

describe("ResponsesAdapter", () => {
  it("writes injected developer context back to native input without losing Codex items or tools", () => {
    const adapter = new ResponsesAdapter();
    const context = adapter.parse({
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Original developer context" }],
        },
        { type: "additional_tools", items: [{ type: "shell" }] },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Implement the change" }],
        },
      ],
      tools: [
        { type: "local_shell" },
        { type: "function", name: "lookup_docs", description: "Lookup docs", parameters: { type: "object" } },
      ],
    }, {
      protocol: "responses",
      traceId: "test",
      keyId: "user-1",
      modelId: "gpt-5.6-sol",
      stream: true,
      agentSource: "codex",
    });

    const developer = context.messages.find((message) => message.role === "system");
    developer?.blocks.push({ type: "text", content: "<session_context>Codex Agent</session_context>" });

    const result = adapter.serialize(context);
    expect(result).not.toHaveProperty("messages");
    expect(result.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: "Original developer context\n<session_context>Codex Agent</session_context>",
        }],
      },
      { type: "additional_tools", items: [{ type: "shell" }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Implement the change" }],
      },
    ]);
    expect(result.tools).toEqual([
      { type: "local_shell" },
      { type: "function", name: "lookup_docs", description: "Lookup docs", parameters: { type: "object" } },
    ]);
  });
});
