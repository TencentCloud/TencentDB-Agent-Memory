import { describe, expect, it } from "vitest";

import { buildCaptureTurn } from "../src/capture.js";

describe("settled transcript capture", () => {
  it("preserves tool-call source order and pairs parallel results by id", () => {
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
      20,
    );

    expect(turn?.assistant).toBe("Inspection complete.");
    expect(turn?.skillMessages.map((message) => [message.role, message.tool_call_id])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool_call", "call-a"],
      ["tool_call", "call-b"],
      ["tool_result", "call-a"],
      ["tool_result", "call-b"],
      ["assistant", undefined],
    ]);
  });

  it("sanitizes recall, credentials, images, errors, and oversized output", () => {
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
          isError: true,
          content: [{ type: "image" }, { type: "text", text: "x".repeat(800) }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Handled the error." }] },
      ],
      500,
    );

    expect(turn?.user).toContain("[recalled memory omitted]");
    expect(turn?.user).toContain('api_key="[REDACTED]"');
    const result = turn?.skillMessages.find((message) => message.role === "tool_result");
    const call = turn?.skillMessages.find((message) => message.role === "tool_call");
    expect(call?.content).toContain('"token":"[REDACTED]"');
    expect(result?.content).toContain("[image]");
    expect(result?.content).toContain("...[capture truncated]");
    expect(result?.tool_call_id).toBe("call-1");
  });

  it("preserves queued user follow-ups in source order", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "initial fallback",
      [
        { role: "user", content: [{ type: "text", text: "first request" }], timestamp: 1 },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "queued follow-up" }], timestamp: 3 },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }], timestamp: 4 },
      ],
      1_000,
    );

    expect(turn?.user).toContain("first request");
    expect(turn?.user).toContain("queued follow-up");
    expect(turn?.skillMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("redacts prefixed environment credentials, nested JSON secrets, URLs, and private keys", () => {
    const turn = buildCaptureTurn(
      "pi:session-1",
      "DEEPSEEK_API_KEY=sk-live DATABASE_URL=postgres://user:pass@db/x",
      [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { headers: { Authorization: "Basic abc" }, client_secret: "hidden", safe: "ok" },
          }],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "AWS_SECRET_ACCESS_KEY=value\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }],
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ],
      2_000,
    );
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("Basic abc");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY=value");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).toContain("safe");
  });

  it("bounds the complete Skill payload and keeps no orphaned tool messages", () => {
    const messages: unknown[] = [{ role: "user", content: "run many tools" }];
    for (let index = 0; index < 30; index += 1) {
      messages.push({
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: "x".repeat(500) } }],
      });
      messages.push({ role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", content: "y".repeat(500) });
    }
    messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "complete" }] });
    const turn = buildCaptureTurn("pi:session-1", "fallback", messages, 1_000, 1, 10_000);
    expect(Buffer.byteLength(JSON.stringify(turn?.skillMessages), "utf8")).toBeLessThanOrEqual(10_000);
    const calls = new Set(turn?.skillMessages.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
    const results = new Set(turn?.skillMessages.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id));
    expect(calls).toEqual(results);
    expect(turn?.skillMessages.at(-1)).toMatchObject({ role: "assistant", content: "complete" });
  });
});
