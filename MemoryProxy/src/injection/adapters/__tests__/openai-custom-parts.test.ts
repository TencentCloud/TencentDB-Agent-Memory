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

describe("OpenAI content parts the adapter does not model", () => {
  it("restores input_audio and file parts unchanged", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "transcribe this" },
          { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
          { type: "file", file: { file_id: "file_fixture" } },
        ],
      },
    ];
    expect(roundtrip(messages)).toEqual(messages);
  });

  it("keeps text and image_url parts unchanged", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "low" } },
        ],
      },
    ];
    expect(roundtrip(messages)).toEqual(messages);
  });
});
