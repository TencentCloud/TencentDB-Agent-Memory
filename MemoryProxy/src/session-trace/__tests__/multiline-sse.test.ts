import { describe, expect, it } from "vitest";
import { OpenAIChatAssembler, parseSseData } from "../assemble.js";
describe("SSE event data assembly", () => {
  it.each(["\n", "\r\n"])("records multi-line data events with separator %j", (newline) => {
    const event = { choices: [{ index: 0, delta: { content: "Hello 世界" }, finish_reason: "stop" }] };
    const frame = ["event: message", ": keepalive", ...JSON.stringify(event, null, 2).split("\n").map((line) => `data: ${line}`), "", ""].join(newline);
    expect(parseSseData(frame)).toEqual([event]);
    const assembler = new OpenAIChatAssembler();
    parseSseData(frame).forEach((value) => assembler.push(value));
    expect(assembler.result()).toEqual({ output: { role: "assistant", content: "Hello 世界" }, stopReason: "stop", toolCallCount: 0 });
  });
  it("keeps ordinary events separate and ignores DONE", () => {
    expect(parseSseData('data: {"value":1}\n\ndata: {"value":2}\n\ndata: [DONE]\n\n')).toEqual([{ value: 1 }, { value: 2 }]);
  });
  it("ignores comments, malformed JSON and non-object payloads", () => {
    expect(parseSseData(': keepalive\n\ndata: not-json\n\ndata: []\n\ndata: null\n\n')).toEqual([]);
  });
  it("accepts the final unterminated block used by the stream tap", () => {
    expect(parseSseData('data: {"value":1}')).toEqual([{ value: 1 }]);
  });
});
