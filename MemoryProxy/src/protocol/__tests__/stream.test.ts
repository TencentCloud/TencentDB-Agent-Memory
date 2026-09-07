import { describe, expect, it } from "vitest";
import { convertSse } from "../stream.js";
import type { WireProtocol } from "../common.js";

const encoder = new TextEncoder();
const frame = (type: string | undefined, data: unknown) => `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
async function run(text: string, from: WireProtocol, to: WireProtocol, cut = 0) {
  const bytes = encoder.encode(text);
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
  const output = await new Response(convertSse(source, from, to)).text();
  return output.split("\n\n").filter(Boolean).map(block => {
    const data = block.split("\n").find(line => line.startsWith("data: "))!.slice(6);
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}
const anth = (reason = "end_turn") => [
  frame("message_start", { type: "message_start", message: { id: "msg_a", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } }),
  frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中文" } }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } }),
  frame("message_stop", { type: "message_stop" }),
].join("");

describe("stream conversion uses semantic terminal events", () => {
  it("Anthropic → Chat emits text, correct cache totals and one terminal marker", async () => {
    const events = await run(anth(), "anthropic", "chat");
    expect(events.filter(event => event === "[DONE]")).toHaveLength(1);
    expect(events.some(event => event.choices?.[0]?.delta?.content === "中文")).toBe(true);
    expect(events.find(event => event.usage)?.usage).toMatchObject({ prompt_tokens: 130, completion_tokens: 5, total_tokens: 135 });
    expect(events.some(event => event.choices?.[0]?.finish_reason === "stop")).toBe(true);
  });
  it("Anthropic → Responses preserves incomplete and nested standard usage", async () => {
    const events = await run(anth("max_tokens"), "anthropic", "responses");
    expect(events.some(event => event.type === "response.completed")).toBe(false);
    const final = events.at(-1);
    expect(final).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 130, input_tokens_details: { cached_tokens: 100 } } } });
    expect(final.response.output[0].content[0].text).toBe("中文");
    expect(events.every(event => Number.isInteger(event.sequence_number))).toBe(true);
  });
  it("Chat → Anthropic handles interleaved parallel tool-argument fragments", async () => {
    const chunk = (delta: unknown, finish_reason: unknown = null, usage?: unknown) => frame(undefined, { id: "chat_a", model: "m", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
    const input = chunk({ role: "assistant", tool_calls: [
      { index: 0, id: "a", type: "function", function: { name: "lookup", arguments: '{"q":' } },
      { index: 1, id: "b", type: "function", function: { name: "calc", arguments: '{"x":' } },
    ] }) + chunk({ tool_calls: [{ index: 1, function: { arguments: "2}" } }, { index: 0, function: { arguments: '"中文"}' } }] }) + chunk({}, "tool_calls", { prompt_tokens: 130, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } }) + "data: [DONE]\n\n";
    const events = await run(input, "chat", "anthropic");
    expect(events.filter(event => event.type === "content_block_start").map(event => event.content_block.id)).toEqual(["a", "b"]);
    for (const [index, expected] of [[0, '{"q":"中文"}'], [1, '{"x":2}']] as const) {
      expect(events.filter(event => event.type === "content_block_delta" && event.index === index).map(event => event.delta.partial_json).join("")).toBe(expected);
    }
    expect(events.find(event => event.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 100 } });
    expect(events.at(-1).type).toBe("message_stop");
  });
  it("Responses → Anthropic maps output text and incomplete completion", async () => {
    const input = frame("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_a", model: "m", status: "in_progress" } })
      + frame("response.output_item.added", { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "message", id: "msg_a", role: "assistant", content: [] } })
      + frame("response.content_part.added", { type: "response.content_part.added", sequence_number: 2, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })
      + frame("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, delta: "partial" })
      + frame("response.incomplete", { type: "response.incomplete", sequence_number: 4, response: { id: "resp_a", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 5 } } });
    const events = await run(input, "responses", "anthropic");
    expect(events.some(event => event.delta?.text === "partial")).toBe(true);
    expect(events.find(event => event.type === "message_delta").delta.stop_reason).toBe("max_tokens");
  });
  it("passes the actual nested Responses failure instead of synthesizing success", async () => {
    const input = frame("response.failed", { type: "response.failed", sequence_number: 0, response: { status: "failed", error: { code: "server_error", message: "fixture failure" } } });
    const events = await run(input, "responses", "anthropic");
    expect(events).toEqual([{ type: "error", error: { type: "api_error", message: "fixture failure" } }]);
  });
  it("does not treat partial output or a naked DONE marker as model completion", async () => {
    for (const input of [frame(undefined, { id: "a", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }), "data: [DONE]\n\n"]) {
      const events = await run(input, "chat", "anthropic");
      expect(events.some(event => event.type === "message_stop")).toBe(false);
      expect(events.at(-1).type).toBe("error");
    }
  });
  it("produces the same semantic result at every UTF-8 byte split", async () => {
    const input = anth();
    for (let cut = 0; cut < encoder.encode(input).length; cut += 7) {
      const events = await run(input, "anthropic", "responses", cut);
      expect(events.at(-1).response.output[0].content[0].text).toBe("中文");
      expect(events.at(-1).type).toBe("response.completed");
    }
  });
});
