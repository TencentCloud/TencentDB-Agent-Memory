import { describe, expect, it } from "vitest";
import { computeCreditDelta } from "../../credit-reporter.js";
import { upstreamAccounting, type ForwardProtocolContext } from "../forward.js";

const pricing = { models: [{ name: "m", input: 1, output: 1, cacheRead: 0.1, cacheWrite5m: 2, cacheWrite1h: 3 }] };
describe("account against the actual upstream schema", () => {
  it("prices Responses total input and nested cached tokens using its declared protocol", () => {
    expect(computeCreditDelta({ input_tokens: 130, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } }, pricing, "m", "https://tokenhub.invalid/custom", "responses")).toBeCloseTo(0.045);
  });
  it("keeps Anthropic cache-write categories even when the client receives Chat usage", () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 } };
    const context: ForwardProtocolContext = { source: "chat", settings: {}, defaultUrl: "", request: {}, warn() {}, actual: { url: "https://tokenhub.invalid/custom", model: "m", protocol: "anthropic", converted: true, usage } };
    const record = upstreamAccounting(context, { prompt_tokens: 130, completion_tokens: 5 }, "m", "wrong-url", "chat");
    expect(record.usage).toEqual(usage);
    expect(computeCreditDelta(record.usage, pricing, record.model, record.url, record.protocol)).toBeCloseTo(0.07);
  });
  it("never substitutes fabricated client counters when a converted upstream omitted usage", () => {
    const context: ForwardProtocolContext = { source: "anthropic", settings: {}, defaultUrl: "", request: {}, warn() {}, actual: { url: "https://example.invalid", model: "m", protocol: "chat", converted: true } };
    expect(upstreamAccounting(context, { input_tokens: 0, output_tokens: 0 }, "m", "", "anthropic").usage).toBeNull();
  });
});
