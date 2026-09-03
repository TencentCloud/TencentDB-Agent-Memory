import { describe, expect, it } from "vitest";
import { completedTurns, latestCompletedTurn } from "../src/capture.js";
import type { OpenCodeMessage } from "../src/types.js";

function user(id: string, text: string): OpenCodeMessage {
  return { info: { id, role: "user", time: { created: 10 } }, parts: [{ type: "text", text }] };
}

function assistant(id: string, parentID: string, parts: OpenCodeMessage["parts"], extra = {}): OpenCodeMessage {
  return { info: { id, parentID, role: "assistant", time: { created: 20, completed: 30 }, ...extra }, parts };
}

describe("OpenCode transcript capture", () => {
  it("preserves ordered tool pairs and final text", () => {
    const messages = [
      user("u1", "inspect project"),
      assistant("a1", "u1", [
        { type: "text", text: "I will inspect." },
        { type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: { filePath: "README.md" }, output: "package name" } },
      ], { finish: "tool-calls" }),
      assistant("a2", "u1", [{ type: "text", text: "The package is memory-core." }]),
    ];
    const turn = latestCompletedTurn("s1", messages, 10_000, 100_000);
    expect(turn?.sourceId).toBe("a2");
    expect(turn?.assistant).toBe("The package is memory-core.");
    expect(turn?.skillMessages.map((m) => m.role)).toEqual([
      "user", "assistant", "tool_call", "tool_result", "assistant",
    ]);
    expect(turn?.skillMessages[2]?.tool_call_id).toBe("call-1");
    expect(turn?.skillMessages[3]?.tool_call_id).toBe("call-1");
  });

  it("ignores failed assistants and captures the last successful retry", () => {
    const turn = latestCompletedTurn("s1", [
      user("u1", "retry this"),
      assistant("bad", "u1", [{ type: "text", text: "partial secret" }], { error: { name: "AbortError" } }),
      assistant("good", "u1", [{ type: "text", text: "completed" }]),
    ], 10_000, 100_000);
    expect(turn?.assistant).toBe("completed");
    expect(JSON.stringify(turn)).not.toContain("partial secret");
  });

  it("uses the final assistant ID rather than content as the durable key", () => {
    const first = latestCompletedTurn("s", [user("u", "same"), assistant("a1", "u", [{ type: "text", text: "same" }])], 1000, 10000);
    const second = latestCompletedTurn("s", [user("u", "same"), assistant("a2", "u", [{ type: "text", text: "same" }])], 1000, 10000);
    expect(first?.key).not.toBe(second?.key);
  });

  it("keeps all natural-language segments around a tool call in the final L0 answer", () => {
    const turn = latestCompletedTurn("s", [
      user("u", "investigate"),
      assistant("a", "u", [
        { type: "text", text: "Checking first." },
        { type: "tool", tool: "read", callID: "call", state: { status: "completed", input: {}, output: "ok" } },
        { type: "text", text: "Final result." },
      ]),
    ], 10_000, 100_000);
    expect(turn?.assistant).toBe("Checking first.\n\nFinal result.");
  });

  it("enumerates every completed turn so an idle recovery cannot skip queued turns", () => {
    const turns = completedTurns("s", [
      user("u1", "first"),
      assistant("a1", "u1", [{ type: "text", text: "one" }]),
      user("u2", "second"),
      assistant("a2", "u2", [{ type: "text", text: "two" }]),
    ], 1000, 10000);
    expect(turns.map((turn) => [turn.user, turn.assistant])).toEqual([["first", "one"], ["second", "two"]]);
  });
});
