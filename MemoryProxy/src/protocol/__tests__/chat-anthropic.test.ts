import { describe, expect, it } from "vitest";
import { anthropicToChat, chatToAnthropic, anthropicJsonToChat, chatJsonToAnthropic } from "../chat-anthropic.js";

const tool = { type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } } };
const messages = [{ role: "user", content: "hello" }];
describe("Chat ↔ Anthropic requests", () => {
  it("maps text, instructions, defaults and explicit output limit without clamping", () => {
    const body = { model: "model", max_completion_tokens: 64000, messages: [{ role: "system", content: "first" }, { role: "developer", content: "second" }, ...messages] };
    const copy = structuredClone(body);
    expect(chatToAnthropic(body)).toEqual({ model: "model", max_tokens: 64000, stream: false, system: [{ type: "text", text: "first" }, { type: "text", text: "second" }], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect(body).toEqual(copy);
  });
  it("requires a documented fallback when the source has no output limit", () => {
    expect(() => chatToAnthropic({ model: "m", messages })).toThrow(/max_tokens/);
    expect(chatToAnthropic({ model: "m", messages }, { maxTokens: 8192 }).max_tokens).toBe(8192);
  });
  it.each([["required", { type: "any" }], ["auto", { type: "auto" }], ["none", { type: "none" }]] as const)("preserves tool selection %s", (source, target) => {
    const converted = chatToAnthropic({ model: "m", messages, max_tokens: 100, tools: [tool], tool_choice: source });
    expect(converted.tool_choice).toEqual(target);
    expect(anthropicToChat(converted).tool_choice).toBe(source);
  });
  it("preserves parallel tool IDs and tool result associations across a complete history", () => {
    const body = { model: "m", max_tokens: 100, tools: [tool], messages: [
      ...messages,
      { role: "assistant", content: "checking", tool_calls: [
        { id: "a", type: "function", function: { name: "lookup", arguments: '{"a":1}' } },
        { id: "b", type: "function", function: { name: "lookup", arguments: '{"b":2}' } },
      ] },
      { role: "tool", tool_call_id: "b", content: "second" },
      { role: "tool", tool_call_id: "a", content: "first" },
    ] };
    const result = anthropicToChat(chatToAnthropic(body));
    expect(result.messages).toEqual(body.messages);
    expect(result.tools).toEqual([tool]);
  });
  it("retains text/image/text order and converts data URLs without fetching", () => {
    const content = [{ type: "text", text: "before" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }, { type: "text", text: "after" }];
    const converted = chatToAnthropic({ model: "m", max_tokens: 100, messages: [{ role: "user", content }] });
    expect(anthropicToChat(converted).messages).toEqual([{ role: "user", content }]);
  });
  it("rejects image tool results when the Chat tool message cannot represent them", () => {
    expect(() => anthropicToChat({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }] }] }] })).toThrow(/tool_result/);
  });
  it("does not silently discard opaque thinking, malformed tool arguments, or strict constraints", () => {
    expect(() => anthropicToChat({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "opaque" }] }] })).toThrow(/thinking/);
    expect(() => chatToAnthropic({ model: "m", max_tokens: 10, messages: [{ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "lookup", arguments: "{" } }] }] })).toThrow(/arguments/);
    expect(() => chatToAnthropic({ model: "m", max_tokens: 10, messages, tools: [{ ...tool, function: { ...tool.function, strict: true } }] })).toThrow(/strict/);
  });
  it("requires explicit acknowledgement before dropping nonportable cache control", () => {
    const input = { model: "m", system: [{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }], messages };
    expect(() => anthropicToChat(input)).toThrow(/cache_control/);
    const warnings: string[] = [];
    expect(anthropicToChat(input, { onWarning: warning => warnings.push(warning) }).messages).toEqual([{ role: "system", content: "prefix" }, ...messages]);
    expect(warnings.join(" ")).toMatch(/cache_control/);
  });
});

describe("Chat ↔ Anthropic JSON responses", () => {
  it("preserves max-token termination, tool arguments and cache accounting", () => {
    const response = { id: "msg_a", model: "m", type: "message", role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } };
    const chat = anthropicJsonToChat(response);
    expect((chat.choices as any[])[0].finish_reason).toBe("length");
    expect(chat.usage).toMatchObject({ prompt_tokens: 130, total_tokens: 135 });
    expect(chatJsonToAnthropic(chat)).toMatchObject({ stop_reason: "max_tokens", content: response.content, usage: { input_tokens: 30, cache_read_input_tokens: 100 } });
  });
  it("maps tool finish independently of whether text was generated", () => {
    const source = { id: "c", model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ type: "function", id: "call_a", function: { name: "lookup", arguments: '{"q":"x"}' } }] }, finish_reason: "tool_calls" }] };
    const target = chatJsonToAnthropic(source);
    expect(target).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call_a", name: "lookup", input: { q: "x" } }] });
    expect((anthropicJsonToChat(target).choices as any[])[0].message.tool_calls).toEqual(source.choices[0].message.tool_calls);
  });
  it("rejects multi-choice responses rather than silently keeping choice zero", () => {
    expect(() => chatJsonToAnthropic({ choices: [{ message: { content: "a" }, finish_reason: "stop" }, { message: { content: "b" }, finish_reason: "stop" }] })).toThrow(/choices/);
  });
});
