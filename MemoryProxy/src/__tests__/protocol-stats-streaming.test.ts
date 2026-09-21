import { describe, it, expect, beforeEach } from "vitest";
import {
  createAnthropicSseToChatSse,
  createChatSseToAnthropicSse,
} from "../common/chat-anthropic-compat.js";
import {
  createAnthropicSseToResponsesSse,
  createResponsesSseToAnthropicSse,
} from "../common/responses-anthropic-compat.js";
import {
  resetProtocolStats,
  getProtocolStats,
} from "../common/protocol-stats.js";

const encoder = new TextEncoder();

async function runThrough(
  transform: TransformStream<Uint8Array, Uint8Array>,
  sseText: string,
): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  const output = input.pipeThrough(transform);
  return new Response(output).text();
}

const anthropicSse = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":10}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5,"cache_read_input_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const chatSse = [
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cached_tokens":7,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
  "data: [DONE]\n\n",
].join("");

const responsesSse = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1,"status":"completed","model":"m","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_tokens":7,"input_tokens_details":{"cached_tokens":7}}}}\n\n',
].join("");

describe("流式转换的 usage/cache 也计入 /metrics（protocol-stats）", () => {
  beforeEach(() => {
    resetProtocolStats();
  });

  it("单跳 Anthropic SSE → Chat：message_delta 的 cache_read_input_tokens 被记录", async () => {
    await runThrough(createAnthropicSseToChatSse({ model: "m" }), anthropicSse);
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(7);
    expect(snap.cache.inputTokens).toBe(10);
  });

  it("单跳 Chat SSE → Anthropic：最终 usage chunk 的 cached_tokens 被记录", async () => {
    await runThrough(createChatSseToAnthropicSse({ model: "m" }), chatSse);
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(7);
    expect(snap.cache.inputTokens).toBe(10);
  });

  it("组合层（Anthropic→Responses 两跳）只计一次 usage/cache", async () => {
    await runThrough(
      createAnthropicSseToResponsesSse({ model: "m" }),
      anthropicSse,
    );
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(7);
    expect(snap.cache.inputTokens).toBe(10);
  });

  it("组合层（Responses→Anthropic 两跳）只计一次 usage/cache", async () => {
    await runThrough(
      createResponsesSseToAnthropicSse({ model: "m" }),
      responsesSse,
    );
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(7);
    expect(snap.cache.inputTokens).toBe(10);
  });
});
