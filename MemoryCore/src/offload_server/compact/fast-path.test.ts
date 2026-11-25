import { expect, test } from "vitest";
import { applyFastPath } from "./fast-path.js";
import type { Message } from "./helpers.js";

const entries = [{ tool_call_id: "call_1", tool_call: "read_file", summary: "small summary",
  timestamp: "2026-01-01T00:00:00Z", score: 1, node_id: null }];
const state = { confirmedOffloadIds: ["call_1"], deletedOffloadIds: [], lastCompactedAt: "" };
const summary = "[Offloaded Tool Result | node: N/A]\nSummary: small summary";

test("replaces a confirmed OpenClaw result and preserves its paired call", () => {
  const call = { role: "assistant", content: [
    { type: "toolCall", id: "call_1", name: "read_file", arguments: {} },
  ] };
  const messages: Message[] = [structuredClone(call), {
    role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "x" }],
  }];

  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 1, deletedCount: 0 });
  expect(messages).toEqual([call, {
    role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: summary }], _offloaded: true,
  }]);
});

const formats = [
  {
    name: "OpenClaw wrapped",
    call: { type: "message", message: { role: "assistant", id: "assistant_1", content: [
      { type: "toolCall", id: "call_1", name: "read_file", arguments: {} },
    ] } },
    result: { type: "message", message: { role: "toolResult", id: "result_1", toolCallId: "call_1", content: [{ type: "text", text: "x" }] } },
    expected: { type: "message", message: { role: "toolResult", id: "result_1", toolCallId: "call_1", content: [{ type: "text", text: summary }] }, _offloaded: true },
  },
  {
    name: "OpenAI",
    call: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    result: { role: "tool", tool_call_id: "call_1", content: "x" },
    expected: { role: "tool", tool_call_id: "call_1", content: summary, _offloaded: true },
  },
  {
    name: "Anthropic",
    call: { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: {} }] },
    result: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    expected: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: summary }], _offloaded: true },
  },
];

test.each(formats)("replaces and preserves a $name pair, including repeat processing", ({ call, result, expected }) => {
  const messages: Message[] = structuredClone([call, result]);
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 1, deletedCount: 0 });
  expect(messages).toEqual([call, expected]);
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual([call, expected]);
});

test.each([false, true])("preserves parallel OpenClaw pairs and cleans only genuine or deleted orphans (wrapped=%s)", (wrapped) => {
  const wrap = (message: Message): Message => wrapped ? { type: "message", message } : message;
  const call = (id: string) => ({ type: "toolCall", id, name: "read_file", arguments: {} });
  const result = (id: string) => wrap({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "x" }] });
  const messages = [
    wrap({ role: "assistant", content: [{ type: "text", text: "reading" }, call("call_1"), call("call_2"), call("deleted"), call("missing_result")] }),
    result("call_1"), result("call_2"), result("deleted"), result("missing_call"),
  ];
  const expected = [
    wrap({ role: "assistant", content: [{ type: "text", text: "reading" }, call("call_1"), call("call_2")] }),
    { ...wrap({ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: summary }] }), _offloaded: true },
    result("call_2"),
  ];
  const compactState = { ...state, deletedOffloadIds: ["deleted"] };
  expect(applyFastPath(messages, entries, compactState)).toEqual({ replacedCount: 1, deletedCount: 2 });
  expect(messages).toEqual(expected);
  expect(applyFastPath(messages, entries, compactState)).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual(expected);
});

test("removes an empty assistant after its genuine orphan call is stripped", () => {
  const messages: Message[] = [{ role: "assistant", content: [{ type: "toolCall", id: "missing_result", name: "read_file", arguments: {} }] }];
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 0, deletedCount: 1 });
  expect(messages).toEqual([]);
});

test("preserves pairs with no confirmed entry and leaves input alone when state is empty", () => {
  const messages: Message[] = [{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }] },
    { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "x" }] }];
  const original = structuredClone(messages);
  expect(applyFastPath(messages, [], state)).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual(original);
  expect(applyFastPath(messages, entries, { ...state, confirmedOffloadIds: [] })).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual(original);
});

test.each(["OpenAI", "Anthropic"])("preserves parallel %s calls while replacing only the confirmed result", (format) => {
  const openai = format === "OpenAI";
  const call: Message = openai
    ? { role: "assistant", content: null, tool_calls: ["call_1", "call_2"].map(id => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } })) }
    : { role: "assistant", content: ["call_1", "call_2"].map(id => ({ type: "tool_use", id, name: "read_file", input: {} })) };
  const result = (id: string, content: string): Message => openai
    ? { role: "tool", tool_call_id: id, content }
    : { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] };
  const messages = [structuredClone(call), result("call_1", "x"), result("call_2", "y")];
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 1, deletedCount: 0 });
  expect(messages).toEqual([call, { ...result("call_1", summary), _offloaded: true }, result("call_2", "y")]);
});

test("replaces a wrapped Anthropic result without losing its block, association or paired call", () => {
  const call = { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: {} }] };
  const messages: Message[] = [structuredClone(call), {
    type: "message", message: { role: "user", id: "call_1", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "original" },
    ] },
  }];
  const result = applyFastPath(messages, entries, state);
  const expected = [call, {
    type: "message", message: { role: "user", id: "call_1", content: [
      { type: "tool_result", tool_use_id: "call_1", content: summary },
    ] }, _offloaded: true,
  }];
  expect(messages).toEqual(expected);
  expect(result).toEqual({ replacedCount: 1, deletedCount: 0 });
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual(expected);
});

test("replaces a wrapped OpenAI result while retaining its complete tool_calls pair", () => {
  const call = { type: "message", message: { role: "assistant", content: null, tool_calls: [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
  ] } };
  const messages: Message[] = [structuredClone(call), {
    type: "message", message: { role: "tool", id: "call_1", tool_call_id: "call_1", content: "original" },
  }];
  const result = applyFastPath(messages, entries, state);
  const expected = [call, {
    type: "message", message: { role: "tool", id: "call_1", tool_call_id: "call_1", content: summary }, _offloaded: true,
  }];
  expect(messages).toEqual(expected);
  expect(result).toEqual({ replacedCount: 1, deletedCount: 0 });
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 0, deletedCount: 0 });
  expect(messages).toEqual(expected);
});

test.each([
  { role: "tool", tool_call_id: "missing_call", content: "original" },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "missing_call", content: "original" }] },
])("still removes a genuinely orphaned wrapped provider result: %j", (message) => {
  const messages: Message[] = [{ type: "message", message }];
  expect(applyFastPath(messages, entries, state)).toEqual({ replacedCount: 0, deletedCount: 1 });
  expect(messages).toEqual([]);
});
