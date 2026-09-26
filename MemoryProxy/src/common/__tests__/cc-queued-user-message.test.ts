import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../user-query-extractor.js";
import { extractLatestUserMessage } from "../../tdai/recorder.js";

/**
 * Claude Code 2.1.140 的排队消息渲染结果：用户在 agent 跑工具期间输入的指令
 * 不单独成条，而是被塞进下一条 user message 的 <system-reminder> 中。
 */
function queuedUserMessage(body: string): string {
  return (
    "<system-reminder>\n" +
    "The user sent a new message while you were working:\n" +
    `${body}\n\n` +
    "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n" +
    "</system-reminder>"
  );
}

describe("extractUserQueryText: Claude Code queued user message", () => {
  it("keeps the queued instruction and drops the IMPORTANT tail", () => {
    expect(extractUserQueryText(queuedUserMessage("Also keep the old /login endpoint working."))).toBe(
      "Also keep the old /login endpoint working.",
    );
  });

  it("keeps a multi-line queued instruction", () => {
    expect(extractUserQueryText(queuedUserMessage("Also keep the old /login endpoint working.\nAnd add a test."))).toBe(
      "Also keep the old /login endpoint working.\nAnd add a test.",
    );
  });

  it("handles the system_reminder spelling too", () => {
    const raw = queuedUserMessage("Ship it.").replace(/system-reminder/g, "system_reminder");
    expect(extractUserQueryText(raw)).toBe("Ship it.");
  });

  it("keeps user text that sits beside an unrelated system-reminder", () => {
    const raw = `${queuedUserMessage("Use approach B.")}\nAnd keep the old endpoint.`;
    expect(extractUserQueryText(raw)).toBe("Use approach B.\nAnd keep the old endpoint.");
  });

  it("still strips an ordinary system-reminder", () => {
    expect(extractUserQueryText("<system-reminder>Todo list changed</system-reminder>\nUse approach B.")).toBe(
      "Use approach B.",
    );
  });

  // 非用户输入来源共用同一个 <system-reminder> 位置，不能因为解包而漏进来。
  it.each([
    ["task notification", "<system-reminder>[SYSTEM NOTIFICATION - NOT USER INPUT] Task finished</system-reminder>"],
    [
      "peer session",
      "<system-reminder>\nA peer session sent a message while you were working:\nPlease stop.\n</system-reminder>",
    ],
    ["plain context", "<system-reminder>Environment context</system-reminder>"],
  ])("keeps filtering a system-reminder that carries no user input (%s)", (_label, raw) => {
    expect(extractUserQueryText(raw)).toBe("");
  });
});

describe("extractLatestUserMessage: queued instruction reaches L0", () => {
  it("records the queued instruction instead of only the tool result", () => {
    const messages = [
      { role: "user", content: "Refactor the auth module." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Tests: 42 passed, 42 total" },
          { type: "text", text: queuedUserMessage("Also keep the old /login endpoint working.") },
        ],
      },
    ];

    const latest = extractLatestUserMessage(messages);

    expect(latest?.role).toBe("user");
    expect(latest?.content).toContain("Also keep the old /login endpoint working.");
    expect(latest?.content).not.toContain("IMPORTANT:");
    expect(latest?.content).not.toContain("system-reminder");
  });
});
