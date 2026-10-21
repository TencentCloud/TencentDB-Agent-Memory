import { describe, expect, it } from "vitest";
import type { CompactState, OffloadEntry } from "../types.js";
import type { Message } from "./helpers.js";
import { applyFastPath } from "./fast-path.js";

const entry: OffloadEntry = {
  tool_call_id: "call_1",
  tool_call: "read_file",
  summary: "The file contains a greeting.",
  timestamp: "2026-01-01T00:00:00Z",
  score: 1,
  node_id: "test-node",
};
const call = { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "example.txt" } };
const summary = `[Offloaded Tool Result | node: test-node]\nSummary: ${entry.summary}`;

function state(confirmed = ["call_1"], deleted: string[] = []): CompactState {
  return { confirmedOffloadIds: confirmed, deletedOffloadIds: deleted, lastCompactedAt: "2026-01-01T00:00:00Z" };
}

function nativePair(): Message[] {
  return [
    { role: "assistant", content: [{ ...call }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: [{ type: "text", text: "large result ".repeat(1000) }], timestamp: 1, isError: false },
  ];
}

describe("top-level OpenClaw fast-path compaction", () => {
  it("replaces a confirmed native result and keeps its valid content envelope", () => {
    const messages = nativePair();
    expect(applyFastPath(messages, [entry], state())).toEqual({ replacedCount: 1, deletedCount: 0 });
    expect(messages[1]).toEqual({
      role: "toolResult", toolCallId: "call_1", toolName: "read_file",
      content: [{ type: "text", text: summary }], timestamp: 1, isError: false, _offloaded: true,
    });
    expect(applyFastPath(messages, [entry], state())).toEqual({ replacedCount: 0, deletedCount: 0 });
    expect(messages[1].content).toEqual([{ type: "text", text: summary }]);
  });

  it("does not strip the assistant call paired with a native result", () => {
    const messages = nativePair();
    applyFastPath(messages, [entry], state());
    expect(messages[0]).toEqual({ role: "assistant", content: [call] });
    expect(messages).toHaveLength(2);
  });

  it("deletes both sides of a native pair while preserving unrelated text", () => {
    const messages = nativePair();
    messages[0].content.unshift({ type: "text", text: "Keep this explanation." });
    messages.unshift({ role: "user", content: "Read the file." });
    applyFastPath(messages, [], state([], ["call_1"]));
    expect(messages).toEqual([
      { role: "user", content: "Read the file." },
      { role: "assistant", content: [{ type: "text", text: "Keep this explanation." }] },
    ]);
  });

  it("preserves a paired native call and removes only the unpaired call in a mixed message", () => {
    const messages = nativePair();
    messages[0].content.unshift({ type: "text", text: "Reading." });
    messages[0].content.push({ ...call, id: "orphan" });
    applyFastPath(messages, [entry], state());
    expect(messages[0].content).toEqual([{ type: "text", text: "Reading." }, call]);
  });

  it("retains an unconfirmed native pair when processing another offload ID", () => {
    const messages = nativePair();
    const original = structuredClone(messages);
    expect(applyFastPath(messages, [], state(["another_call"]))).toEqual({ replacedCount: 0, deletedCount: 0 });
    expect(messages).toEqual(original);
  });

  it("removes a native result that has no matching assistant call", () => {
    const messages = nativePair().slice(1);
    applyFastPath(messages, [entry], state());
    expect(messages).toEqual([]);
  });
});

describe("existing fast-path contracts", () => {
  it.each([
    ["OpenAI", { role: "tool", tool_call_id: "call_1", content: "result" }],
    ["Anthropic", { type: "tool_result", tool_use_id: "call_1", content: "result" }],
    ["wrapped OpenClaw", { type: "message", message: { role: "toolResult", id: "call_1", content: [{ type: "text", text: "result" }] } }],
    ["Anthropic user block", { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] }],
  ])("keeps %s pairs during confirmed replacement", (_name, result) => {
    const messages: Message[] = [{ role: "assistant", content: [{ ...call }] }, structuredClone(result)];
    expect(applyFastPath(messages, [entry], state())).toEqual({ replacedCount: 1, deletedCount: 0 });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([call]);
    expect(messages[1]._offloaded).toBe(true);
  });

  it("leaves messages untouched when no offload state is active", () => {
    const messages = nativePair();
    const original = structuredClone(messages);
    expect(applyFastPath(messages, [], state([]))).toEqual({ replacedCount: 0, deletedCount: 0 });
    expect(messages).toEqual(original);
  });
});
