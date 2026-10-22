import { describe, expect, it } from "vitest";

import { parseMemCommand } from "../parser.js";

describe("parseMemCommand client envelopes", () => {
  it("parses an OpenClaw timestamp-prefixed task update", () => {
    const parsed = parseMemCommand(
      {
        messages: [
          {
            role: "user",
            content: "[Thu 2026-10-22 10:51 GMT+8] mem:update-task TASK_DESC_V2",
          },
        ],
      },
      "openclaw",
    );

    expect(parsed).toMatchObject({
      command: "update-task",
      args: "TASK_DESC_V2",
    });
  });

  it("finds the user command before trailing Claude Code system metadata", () => {
    const parsed = parseMemCommand(
      {
        messages: [
          { role: "user", content: "mem:update-task confirm" },
          {
            role: "system",
            content: [{ type: "text", text: "<total_tokens>15000000 tokens left</total_tokens>" }],
          },
        ],
      },
      "claude-code",
    );

    expect(parsed).toMatchObject({
      command: "update-task",
      args: "confirm",
    });
  });

  it("does not scan backward past terminal tool messages", () => {
    const parsed = parseMemCommand(
      {
        messages: [
          { role: "user", content: "mem:update-task TASK_DESC_V2" },
          { role: "assistant", content: "running tool" },
          { role: "tool", content: "tool output" },
        ],
      },
      "claude-code",
    );

    expect(parsed).toBeNull();
  });

  it("does not execute command-like text embedded in ordinary input", () => {
    const parsed = parseMemCommand(
      {
        messages: [
          {
            role: "user",
            content: 'Please explain why "mem:update-task confirm" is a command.',
          },
        ],
      },
      "openclaw",
    );

    expect(parsed).toBeNull();
  });

  it("does not strip arbitrary bracketed user text", () => {
    const parsed = parseMemCommand(
      {
        messages: [
          {
            role: "user",
            content: "[Thu 2026-10-22 10:51] mem:help",
          },
        ],
      },
      "openclaw",
    );

    expect(parsed).toBeNull();
  });
});
