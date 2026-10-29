import { expect, test } from "vitest";
import { extractToolResultId, isToolResultMessage } from "./helpers.js";

test.each([undefined, null, "", 0, {}])("ignores an invalid OpenClaw association: %j", (toolCallId) => {
  expect(extractToolResultId({ role: "toolResult", toolCallId })).toBeNull();
});

test.each(["user", "assistant", "system"])("does not use an unrelated %s toolCallId", (role) => {
  expect(extractToolResultId({ role, toolCallId: "call_1", content: "hello" })).toBeNull();
});

test("recognizes a wrapped tool role with its explicit association", () => {
  const message = { type: "message", message: { role: "tool", tool_call_id: "call_1", content: "x" } };
  expect(isToolResultMessage(message)).toBe(true);
  expect(extractToolResultId(message)).toBe("call_1");
});

test("recognizes the tool_result role alias at the top level", () => {
  expect(isToolResultMessage({ role: "tool_result", tool_use_id: "call_1" })).toBe(true);
});

test("wrapped OpenClaw results link to the tool call, not the message ID", () => {
  const message = { type: "message", message: {
    role: "toolResult", id: "message_1", toolCallId: "call_1", content: [],
  } };
  expect(isToolResultMessage(message)).toBe(true);
  expect(extractToolResultId(message)).toBe("call_1");
});

test("ordinary wrapped messages do not expose their own ID as a tool result ID", () => {
  expect(extractToolResultId({ type: "message", message: {
    role: "assistant", id: "call_1", content: [{ type: "text", text: "hello" }],
  } })).toBeNull();
});

test.each([
  { role: "toolResult", toolCallId: "call_1", content: [] },
  { role: "tool", tool_call_id: "call_1", content: "x" },
  { type: "tool_result", tool_use_id: "call_1", content: "x" },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
  { type: "message", message: { role: "toolResult", id: "call_1", content: [] } },
  { type: "message", message: { role: "tool_result", id: "message_1", tool_use_id: "call_1" } },
])("recognizes a supported tool result and extracts its association: %j", (message) => {
  expect(isToolResultMessage(message)).toBe(true);
  expect(extractToolResultId(message)).toBe("call_1");
});

test.each([
  { role: "user", content: "hello" },
  { role: "assistant", id: "message_1", content: [] },
  { type: "message", message: { role: "user", id: "message_1", content: "hello" } },
])("does not treat ordinary messages as tool results: %j", (message) => {
  expect(isToolResultMessage(message)).toBe(false);
  expect(extractToolResultId(message)).toBeNull();
});

test("does not claim support for recursively nested message envelopes", () => {
  const message = { type: "message", message: { type: "message", message: {
    role: "toolResult", toolCallId: "call_1", content: [],
  } } };
  expect(isToolResultMessage(message)).toBe(false);
  expect(extractToolResultId(message)).toBeNull();
});

test.each([
  { role: "tool", id: "message_1", tool_call_id: "call_1", content: "original" },
  { role: "user", id: "message_1", content: [{ type: "tool_result", tool_use_id: "call_1", content: "original" }] },
])("prefers the wrapped provider result association over its message ID: %j", (message) => {
  const wrapped = { type: "message", message };
  expect(isToolResultMessage(wrapped)).toBe(true);
  expect(extractToolResultId(wrapped)).toBe("call_1");
});
