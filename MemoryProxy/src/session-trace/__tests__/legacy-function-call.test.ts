import { describe, expect, it } from "vitest";
import { OpenAIChatAssembler, openaiReplyFromJson } from "../assemble.js";
describe("OpenAI streamed legacy function calls", () => {
  it("retains fragmented calls with the same reply shape as JSON responses", () => {
    const assembler = new OpenAIChatAssembler();
    assembler.push({ choices: [{ index: 0, delta: { role: "assistant", content: null, function_call: { name: "lookup", arguments: '{"city":' } } }] });
    assembler.push({ choices: [{ index: 0, delta: { function_call: { arguments: '"Paris"}' } }, finish_reason: "function_call" }] });
    const message = { role: "assistant", content: null, function_call: { name: "lookup", arguments: '{"city":"Paris"}' } };
    const expected = { output: message, stopReason: "function_call", toolCallCount: 1 };
    expect(openaiReplyFromJson({ choices: [{ message, finish_reason: "function_call" }] })).toEqual(expected);
    expect(assembler.result()).toEqual(expected);
  });
  it("keeps modern tool calls and textual fields", () => {
    const assembler = new OpenAIChatAssembler();
    assembler.push({ choices: [{ index: 0, delta: { reasoning_content: "Thought", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    expect(assembler.result()).toEqual({ output: { role: "assistant", content: null, reasoning_content: "Thought", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }, stopReason: "tool_calls", toolCallCount: 1 });
  });
  it("keeps ordinary text responses and ignores other choices", () => {
    const assembler = new OpenAIChatAssembler();
    assembler.push({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }, { index: 1, delta: { function_call: { name: "other", arguments: "{}" } } }] });
    expect(assembler.result()).toEqual({ output: { role: "assistant", content: "hello" }, stopReason: "stop", toolCallCount: 0 });
  });
});
