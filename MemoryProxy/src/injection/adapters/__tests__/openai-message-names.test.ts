import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../openai.js";
import type { AgentContextMetadata } from "../../types.js";
const metadata: AgentContextMetadata = { protocol: "openai", traceId: "fixture", keyId: "fixture", modelId: "fixture", stream: false, agentSource: "codebuddy" };
async function roundtrip(messages: Record<string, unknown>[]) {
  const adapter = new OpenAIAdapter();
  return adapter.serialize(adapter.parse({ messages }, metadata)).messages;
}
describe("OpenAI participant names", () => {
  it.each(["system", "user", "assistant"])("preserves a named %s message", async (role) => {
    const messages = [{ role, content: "hello", name: "participant_fixture" }];
    expect(await roundtrip(messages)).toEqual(messages);
  });
  it("preserves names alongside assistant reasoning and tool calls", async () => {
    const messages = [{ role: "assistant", content: null, name: "researcher", reasoning_content: "thinking", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }];
    expect(await roundtrip(messages)).toEqual(messages);
  });
  it("keeps unnamed messages unchanged", async () => {
    const messages = [{ role: "system", content: "Instructions" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    expect(await roundtrip(messages)).toEqual(messages);
  });
});
