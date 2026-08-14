import { describe, expect, it } from "vitest";

import { buildCaptureTurn, hasCompletedAssistant } from "../src/capture.js";

describe("buildCaptureTurn", () => {
  it("preserves tool-call order and pairs results by id", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "Inspect the project",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 10,
          content: [
            { type: "text", text: "I will inspect both files." },
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
          ],
        },
        { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "A" }], timestamp: 11 },
        { role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "B" }], timestamp: 12 },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Inspection complete." }], timestamp: 13 },
      ],
      1_000,
    );

    expect(turn?.assistant).toBe("Inspection complete.");
    expect(turn?.skillMessages.map((m) => [m.role, m.tool_call_id])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool_call", "call-a"],
      ["tool_call", "call-b"],
      ["tool_result", "call-a"],
      ["tool_result", "call-b"],
      ["assistant", undefined],
    ]);
  });

  it("redacts credentials, collapses images, and truncates oversized output", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "BEGIN_TENCENTDB_RECALLED_MEMORY\nsecret\nEND_TENCENTDB_RECALLED_MEMORY\napi_key=hunter2",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { token: "abc" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "image" }, { type: "text", text: "x".repeat(800) }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Handled." }] },
      ],
      500,
    );

    expect(turn?.user).toContain("[recalled memory omitted]");
    expect(turn?.user).toContain('api_key="[REDACTED]"');
    const call = turn?.skillMessages.find((m) => m.role === "tool_call");
    expect(call?.content).toContain('"token":"[REDACTED]"');
    const result = turn?.skillMessages.find((m) => m.role === "tool_result");
    expect(result?.content).toContain("[image]");
    expect(result?.content).toContain("...[capture truncated]");
  });

  it("drops orphaned tool messages (call without result)", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "fallback",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "orphan", name: "read", arguments: {} }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ],
      1_000,
    );
    expect(turn?.skillMessages.find((m) => m.role === "tool_call")).toBeUndefined();
  });

  it("never leaves orphaned tool messages after capping", () => {
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "run many tools" }] }];
    const toolCalls: unknown[] = [];
    for (let i = 0; i < 300; i += 1) {
      toolCalls.push({ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `f${i}` } });
    }
    messages.push({ role: "assistant", stopReason: "toolUse", content: toolCalls });
    for (let i = 0; i < 300; i += 1) {
      messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: "r" }] });
    }
    messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });

    const turn = buildCaptureTurn("pi:session-1", "fallback", messages, 1_000);
    const skill = turn!.skillMessages;
    const calls = new Set(skill.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
    const results = new Set(skill.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id));
    expect([...calls].every((id) => results.has(id))).toBe(true);
    expect([...results].every((id) => calls.has(id))).toBe(true);
  });

  it("returns null when there is no completed assistant message", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "fallback",
      [{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] }],
      1_000,
    );
    expect(turn).toBeNull();
  });
});

describe("hasCompletedAssistant", () => {
  it("detects a completed assistant turn", () => {
    expect(
      hasCompletedAssistant([
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }] },
      ]),
    ).toBe(true);
  });

  it("rejects an aborted assistant turn", () => {
    expect(
      hasCompletedAssistant([
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
      ]),
    ).toBe(false);
  });

  it("rejects a truncated (length) assistant turn", () => {
    expect(
      hasCompletedAssistant([
        { role: "assistant", stopReason: "length", content: [{ type: "text", text: "cut off" }] },
      ]),
    ).toBe(false);
  });

  it("rejects a tool-use assistant turn", () => {
    expect(
      hasCompletedAssistant([
        { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
      ]),
    ).toBe(false);
  });

  it("rejects a deferred assistant turn", () => {
    expect(
      hasCompletedAssistant([
        { role: "assistant", stopReason: "deferred", content: [{ type: "text", text: "queued" }] },
      ]),
    ).toBe(false);
  });

  it("redacts nested credentials inside structured tool arguments", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "fallback",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "http",
              arguments: { headers: { Authorization: "Bearer secret" }, nested: { client_secret: "hidden" } },
            },
          ],
        },
        { role: "toolResult", toolCallId: "c1", toolName: "http", content: [{ type: "text", text: "ok" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ],
      2_000,
    );
    const call = turn?.skillMessages.find((m) => m.role === "tool_call");
    expect(call?.content).toContain("[REDACTED]");
    expect(call?.content).not.toContain("Bearer secret");
    expect(call?.content).not.toContain('"hidden"');
    expect(call?.content).toContain('"client_secret":"[REDACTED]"');
  });

  it("redacts a multi-word quoted value completely", () => {
    const redacted = buildCaptureTurn(
      "pi:session-1",
      'password = "my secret value"',
      [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
      2_000,
    );
    expect(redacted?.user).not.toContain("my secret value");
    expect(redacted?.user).toContain("[REDACTED]");
  });

  it("redacts additional credential shapes", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "fallback",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "aws",
              arguments: { access_key_id: "AKIA", secret_access_key: "xyz", private_token: "glpat" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "aws",
          content: [{ type: "text", text: "Authorization: Bearer abc123\npasscode: 9999" }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ],
      2_000,
    );
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain("xyz");
    expect(serialized).not.toContain("glpat");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("9999");
  });
});
