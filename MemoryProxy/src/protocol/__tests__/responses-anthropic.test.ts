import { describe, expect, it } from "vitest";
import { responsesToAnthropic, anthropicToResponses, anthropicJsonToResponses, responsesJsonToAnthropic } from "../responses-anthropic.js";

describe("Responses ↔ Anthropic direct requests", () => {
  it.each(["hello", [{ role: "user", content: "hello" }], [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]])("accepts standard input form %j", input => {
    expect(responsesToAnthropic({ model: "m", input, max_output_tokens: 64000 })).toEqual({ model: "m", max_tokens: 64000, stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
  });
  it("preserves ordered multimodal tool results without a Chat intermediate", () => {
    const output = [{ type: "input_text", text: "before" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_text", text: "after" }];
    const body = { model: "m", max_output_tokens: 100, input: [
      { type: "function_call", call_id: "call_a", name: "lookup", arguments: '{"x":1}' },
      { type: "function_call_output", call_id: "call_a", output },
    ] };
    const anth = responsesToAnthropic(body);
    expect(anth.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "lookup", input: { x: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "after" }] }] },
    ]);
    expect((anthropicToResponses(anth).input as Record<string, unknown>[])[1]).toMatchObject({ type: "function_call_output", call_id: "call_a", output });
  });
  it("preserves assistant text / tool / text item order", () => {
    const body = { model: "m", messages: [{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "tool_use", id: "a", name: "lookup", input: {} }, { type: "text", text: "last" }] }] };
    const input = anthropicToResponses(body).input as Record<string, unknown>[];
    expect(input.map(item => item.type)).toEqual(["message", "function_call", "message"]);
    expect(responsesToAnthropic({ ...anthropicToResponses(body), max_output_tokens: 100 }).messages).toEqual(body.messages);
  });
  it("retains tools, tool choice, instructions and disabled parallel calls", () => {
    const result = responsesToAnthropic({ model: "m", input: "hello", max_output_tokens: 100, instructions: "be precise", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }], tool_choice: "required", parallel_tool_calls: false });
    expect(result).toMatchObject({ system: [{ type: "text", text: "be precise" }], tools: [{ name: "lookup", input_schema: { type: "object" } }], tool_choice: { type: "any", disable_parallel_tool_use: true } });
  });
  it.each([
    { previous_response_id: "resp_old" }, { conversation: "conv_a" }, { background: true },
    { input: [{ type: "reasoning", encrypted_content: "opaque" }] },
    { input: [{ role: "user", content: [{ type: "input_image", file_id: "file_a" }] }] },
  ])("explicitly rejects unsupported state or nonportable content %j", extra => {
    expect(() => responsesToAnthropic({ model: "m", input: "hello", max_output_tokens: 100, ...extra })).toThrow();
  });
});

describe("Responses ↔ Anthropic complete JSON responses", () => {
  const anth = { id: "msg_a", model: "m", role: "assistant", type: "message", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } };
  it("keeps incomplete status and standard nested cache usage", () => {
    expect(anthropicJsonToResponses(anth)).toMatchObject({ object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 130, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } } });
  });
  it("keeps incomplete termination in the reverse direction", () => {
    const result = responsesJsonToAnthropic({ id: "resp_a", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial", annotations: [] }] }] });
    expect(result).toMatchObject({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] });
  });
  it("does not change failed or in_progress results into successful messages", () => {
    expect(() => responsesJsonToAnthropic({ status: "failed", error: { message: "fixture failure" }, output: [] })).toThrow(/fixture failure/);
    expect(() => responsesJsonToAnthropic({ status: "in_progress", output: [] })).toThrow(/in_progress/);
  });
  it("preserves function calls as distinct ordered output items", () => {
    const result = anthropicJsonToResponses({ ...anth, stop_reason: "tool_use", content: [{ type: "text", text: "first" }, { type: "tool_use", id: "call_a", name: "lookup", input: { x: 1 } }] });
    expect((result.output as Record<string, unknown>[]).map(item => item.type)).toEqual(["message", "function_call"]);
    expect(responsesJsonToAnthropic(result)).toMatchObject({ stop_reason: "tool_use", content: [{ type: "text", text: "first" }, { type: "tool_use", id: "call_a", name: "lookup", input: { x: 1 } }] });
  });
});
