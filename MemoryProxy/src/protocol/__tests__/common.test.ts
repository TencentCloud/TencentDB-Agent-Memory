import { describe, expect, it } from "vitest";
import { convertUsage, createSseDecoder, type SseFrame } from "../common.js";

describe("upstream usage conversion", () => {
  const anthropic = {
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
  };
  it("includes cache reads and writes once in OpenAI input totals", () => {
    expect(convertUsage(anthropic, "anthropic", "chat")).toEqual({
      prompt_tokens: 130, completion_tokens: 5, total_tokens: 135,
      prompt_tokens_details: { cached_tokens: 100 },
    });
    expect(convertUsage(anthropic, "anthropic", "responses")).toEqual({
      input_tokens: 130, output_tokens: 5, total_tokens: 135,
      input_tokens_details: { cached_tokens: 100 },
    });
  });
  it.each(["chat", "responses"] as const)("subtracts cache reads from %s totals", source => {
    const usage = source === "chat"
      ? { prompt_tokens: 130, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } }
      : { input_tokens: 130, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } };
    expect(convertUsage(usage, source, "anthropic")).toEqual({
      input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 100,
    });
  });
  it("does not turn absent usage or absent input into a measured zero", () => {
    expect(convertUsage(undefined, "chat", "anthropic")).toBeUndefined();
    expect(convertUsage({ completion_tokens: 0 }, "chat", "anthropic")).toEqual({ output_tokens: 0 });
  });
  it("retains native provider usage without modifying the source", () => {
    const before = structuredClone(anthropic);
    expect(convertUsage(anthropic, "anthropic", "anthropic")).toEqual(before);
    convertUsage(anthropic, "anthropic", "chat");
    expect(anthropic).toEqual(before);
  });
  it.each([
    { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
    { prompt_tokens: -1 }, { completion_tokens: Number.NaN },
  ])("rejects inconsistent upstream counters: %j", usage => {
    expect(() => convertUsage(usage, "chat", "anthropic")).toThrow();
  });
});

async function decode(chunks: Uint8Array[], limit?: number): Promise<SseFrame[]> {
  const input = new ReadableStream<Uint8Array>({ start(controller) {
    chunks.forEach(chunk => controller.enqueue(chunk)); controller.close();
  } });
  const reader = input.pipeThrough(createSseDecoder(limit)).getReader();
  const frames: SseFrame[] = [];
  for (;;) { const next = await reader.read(); if (next.done) return frames; frames.push(next.value); }
}

describe("SSE framing at arbitrary transport boundaries", () => {
  const encoder = new TextEncoder();
  it("keeps UTF-8, CRLF, multiline data and significant spaces at every byte split", async () => {
    const bytes = encoder.encode(': ping\r\nevent: delta\r\nid: 12\r\ndata:  中文\r\ndata: next\r\n\r\ndata: [DONE]\n\n');
    const expected = [{ event: "delta", data: " 中文\nnext", id: "12" }, { event: "message", data: "[DONE]", id: "12" }];
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(await decode([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(expected);
    }
  });
  it("supports lone CR separators including a final blank line", async () => {
    expect(await decode([encoder.encode("data: hello\r\r")])).toEqual([{ event: "message", data: "hello" }]);
  });
  it("rejects truncated data frames instead of treating EOF as a completed event", async () => {
    await expect(decode([encoder.encode("data: partial\n")])).rejects.toThrow(/truncated/i);
  });
  it("bounds a frame across both one long line and many short data lines", async () => {
    await expect(decode([encoder.encode("data: " + "x".repeat(40))], 32)).rejects.toThrow(/limit/i);
    await expect(decode([encoder.encode("data: x\n".repeat(8))], 32)).rejects.toThrow(/limit/i);
  });
  it("propagates downstream cancellation to the upstream stream", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(encoder.encode("data: hello\n\n")); },
      cancel() { cancelled = true; },
    });
    const reader = source.pipeThrough(createSseDecoder()).getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
});
