import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic", traceId: "fixture", keyId: "fixture", modelId: "fixture",
  stream: false, agentSource: "claude-code",
};
function roundtrip(body: Record<string, unknown>) {
  const adapter = new AnthropicAdapter();
  return adapter.serialize(adapter.parse(body, metadata));
}
describe("Anthropic system prompt cache boundaries", () => {
  it.each(["5m", "1h"])("preserves the cache marker on a single system block (%s)", async (ttl) => {
    const system = [{ type: "text", text: "Stable instructions", cache_control: { type: "ephemeral", ttl } }];
    const body = { model: "fixture", max_tokens: 1, system, messages: [{ role: "user", content: "hello" }] };
    const out = await roundtrip(body);
    expect(out.system).toEqual(system);
    expect(out.model).toBe("fixture");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });
  it("preserves the simple string form", async () => {
    const out = await roundtrip({ system: "Instructions", messages: [] });
    expect(out.system).toBe("Instructions");
  });
  it("preserves marked multi-block system prompts", async () => {
    const system = [{ type: "text", text: "First" }, { type: "text", text: "Second", cache_control: { type: "ephemeral" } }];
    expect((await roundtrip({ system, messages: [] })).system).toEqual(system);
  });
});
