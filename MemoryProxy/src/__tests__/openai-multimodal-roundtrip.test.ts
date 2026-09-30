import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../injection/adapters/openai.js";
import { InjectionPipeline } from "../injection/pipeline.js";
import { HookRegistryImpl } from "../injection/registry.js";
import type { AgentContextMetadata } from "../injection/types.js";
const metadata: AgentContextMetadata = { protocol: "openai", traceId: "test", keyId: "test", modelId: "test", stream: false, agentSource: "codebuddy" };
const adapter = new OpenAIAdapter();
const parts = [
  { type: "video_url", video_url: { url: "https://example.test/video.mp4", fps: 2 } },
  { type: "input_audio", input_audio: { data: "AAECAw==", format: "wav" } },
  { type: "file", file: { file_id: "file-test", filename: "notes.pdf" } },
  { type: "vendor_part", payload: { nested: [null, 0, false, "中文"] }, extra: true },
];
function body(content: unknown[]) { return { model: "test", messages: [{ role: "user", content }] }; }
describe("OpenAI same-protocol content round trip", () => {
  it.each(parts)("preserves $type with its provider fields", (part) => {
    const original = body([{ type: "text", text: "inspect this" }, part]);
    expect(adapter.serialize(adapter.parse(original, metadata))).toEqual(original);
  });
  it("preserves mixed modality order through a pipeline that injects context", async () => {
    const registry = new HookRegistryImpl();
    registry.register({ id: "test-memory", point: "system.suffix", priority: 10, description: "test", execute: () => [{ type: "text", content: "memory" }] });
    const pipeline = new InjectionPipeline(registry, new Map([["openai", adapter]]));
    const image = { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } };
    const content = [{ type: "text", text: "compare" }, image, ...parts];
    const original = { model: "test", messages: [
      { role: "system", content: "system instructions" },
      { role: "user", content },
    ] };
    const result = await pipeline.process(original, metadata);
    const messages = result.messages as Record<string, unknown>[];
    expect(messages.find(m => m.role === "user")?.content).toEqual(content);
    expect(JSON.stringify(messages)).toContain("memory");
  });
  it.each(parts)("preserves opaque $type parts in system messages", (part) => {
    const original = { model: "test", messages: [{ role: "system", content: [part] }] };
    expect(adapter.serialize(adapter.parse(original, metadata))).toEqual(original);
  });
  it("retains the existing representation for synthetic custom blocks", () => {
    const ctx = adapter.parse(body([]), metadata);
    ctx.messages[0].blocks.push({ type: "custom", content: "injected", metadata: { source: "hook" } });
    expect((adapter.serialize(ctx).messages as Record<string, unknown>[])[0].content).toEqual([{ type: "custom", content: "injected", source: "hook" }]);
  });
});
