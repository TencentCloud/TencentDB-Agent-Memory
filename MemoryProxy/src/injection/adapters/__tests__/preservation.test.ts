import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import { OpenAIAdapter } from "../openai.js";
import { InjectionPipeline } from "../../pipeline.js";
import { HookRegistryImpl } from "../../registry.js";
import type { AgentContextMetadata } from "../../types.js";
import { anthropicToResponses } from "../../../protocol/responses-anthropic.js";

const meta: AgentContextMetadata = { protocol: "anthropic", traceId: "fixture", keyId: "fixture", modelId: "m", stream: false, agentSource: "fixture" };
const image = { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } };
describe("native injection preserves content that is not being injected", () => {
  const adapter = new AnthropicAdapter();
  it("preserves nested tool output images, explicit false, and URL image sources", () => {
    const body = { messages: [{ role: "user", content: [image, { type: "tool_result", tool_use_id: "call_a", is_error: false, content: [image, { type: "text", text: "caption" }] }] }] };
    expect(adapter.serialize(adapter.parse(body, meta))).toEqual(body);
  });
  it("keeps single system cache metadata and opaque content", () => {
    const body = { system: [{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }], messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "signed" }, { type: "redacted_thinking", data: "opaque" }] }] };
    expect(adapter.serialize(adapter.parse(body, meta))).toEqual(body);
  });
  it("preserves native server tools without inventing input_schema or description", () => {
    const body = { messages: [], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] };
    expect(adapter.serialize(adapter.parse(body, meta))).toEqual(body);
  });
  it("applies real injection while preserving original tool history and cache fields", async () => {
    const registry = new HookRegistryImpl();
    registry.register({ id: "memory-fixture", point: "system.suffix", priority: 100, description: "test memory", execute: () => [{ type: "text", content: "remember fixture" }] });
    const pipeline = new InjectionPipeline(registry, new Map([["anthropic", adapter]]));
    const body = { model: "m", max_tokens: 100, system: [{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [image] }] }] };
    const result = await pipeline.process(body, meta);
    expect(result.messages).toEqual(body.messages);
    expect(JSON.stringify(result.system)).toContain("remember fixture");
    expect(JSON.stringify(result.system)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(body.system[0].text).toBe("prefix");
    const outbound = anthropicToResponses(result, { onWarning: () => {} });
    expect(JSON.stringify(outbound.input)).toContain("remember fixture");
    expect(JSON.stringify(outbound.input)).toContain("https://example.invalid/image.png");
  });
  it("keeps a modified text block rather than restoring stale native content", () => {
    const ctx = adapter.parse({ messages: [{ role: "user", content: [{ type: "text", text: "before", citations: [] }] }] }, meta);
    ctx.messages[0].blocks[0].content = "after";
    expect(adapter.serialize(ctx).messages).toEqual([{ role: "user", content: [{ type: "text", text: "after", citations: [] }] }]);
  });
  it("keeps an explicit empty tool array", () => {
    expect(adapter.serialize(adapter.parse({ messages: [], tools: [] }, meta)).tools).toEqual([]);
  });
});

describe("OpenAI native fields survive injection adapters", () => {
  const adapter = new OpenAIAdapter();
  const metadata = { ...meta, protocol: "openai" as const };
  it("preserves custom user/assistant content, message extras, and strict tool definitions", () => {
    const body = { messages: [
      { role: "user", name: "alice", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] },
      { role: "assistant", content: [{ type: "refusal", refusal: "no" }], reasoning_content: "opaque", provider_state: { a: 1 } },
    ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" }, strict: true }, provider_field: true }] };
    expect(adapter.serialize(adapter.parse(body, metadata))).toEqual(body);
  });
  it("preserves text array metadata and observes changed text", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "before", cache_control: { type: "ephemeral" } }] }] };
    const ctx = adapter.parse(body, metadata);
    ctx.messages[0].blocks[0].content = "after";
    expect(adapter.serialize(ctx).messages).toEqual([{ role: "user", content: [{ ...body.messages[0].content[0], text: "after" }] }]);
  });
});
