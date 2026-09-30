import { describe, expect, it } from "vitest";

import {
  canonicalizeMessage,
  extractText,
  injectRecallContext,
  selectRecallContext,
} from "./chat-protocol.js";
import type { ChatCompletionRequest } from "./types.js";

describe("model proxy chat protocol", () => {
  it("injects recall next to the last user message without mutating the input", () => {
    const request: ChatCompletionRequest = {
      model: "test-model",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "original question" },
      ],
    };

    const injected = injectRecallContext(request, "prefers TypeScript");

    expect(request.messages[1].content).toBe("original question");
    expect(injected.messages[1].content).toContain("original question");
    expect(injected.messages[1].content).toContain("<tdai-memory>");
    expect(injected.messages[1].content).toContain("prefers TypeScript");
    expect(extractText(injected.messages[1].content)).toBe("original question");
  });

  it("preserves multimodal parts and appends a text memory part", () => {
    const request: ChatCompletionRequest = {
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        ],
      }],
    };

    const injected = injectRecallContext(request, "user likes short answers");
    const parts = injected.messages[0].content as unknown[];

    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.test/a.png" },
    });
    expect(extractText(parts)).toBe("describe this");
  });

  it("combines split and legacy recall fields without duplicating identical text", () => {
    expect(selectRecallContext({
      append_system_context: "persona",
      prepend_context: "fact",
      context: "persona",
    }, 100)).toBe("persona\n\nfact");
  });

  it("canonicalizes tool calls independently of object key order", () => {
    const first = canonicalizeMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", function: { name: "read", arguments: "{}" }, type: "function" }],
    });
    const second = canonicalizeMessage({
      role: "assistant",
      tool_calls: [{ type: "function", function: { arguments: "{}", name: "read" }, id: "1" }],
      content: "",
    });
    expect(first).toBe(second);
  });
});
