import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";
const metadata: AgentContextMetadata = { protocol: "anthropic", traceId: "fixture", keyId: "fixture", modelId: "fixture", stream: false, agentSource: "claude-code" };
describe("Anthropic referenced images", () => {
  it.each([
    { type: "url", url: "https://images.example.test/screenshot.png" },
    { type: "file", file_id: "file_fixture" },
    { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
  ])("preserves $type image sources through adapter round-trip", async (source) => {
    const content = [{ type: "image", source, cache_control: { type: "ephemeral" } }, { type: "text", text: "Describe the image" }];
    const body = { max_tokens: 1, messages: [{ role: "user", content }] };
    const before = structuredClone(body);
    const adapter = new AnthropicAdapter();
    const out = adapter.serialize(adapter.parse(body, metadata));
    expect(out.messages).toEqual(body.messages);
    expect(body).toEqual(before);
  });
});
