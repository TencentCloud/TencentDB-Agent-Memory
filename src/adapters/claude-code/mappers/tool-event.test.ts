import { describe, expect, it } from "vitest";
import { mapPostToolUseInput } from "./tool-event.js";

describe("mapPostToolUseInput", () => {
  it("maps Claude Code PostToolUse fields into a normalized event", () => {
    const event = mapPostToolUseInput({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "C:/tmp/project",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok" },
      duration_ms: 123,
    });

    expect(event.toolName).toBe("Bash");
    expect(event.toolUseId).toBe("toolu_1");
    expect(event.status).toBe("success");
    expect(event.sessionKey).toMatch(/^agent:claude-code-/);
    expect(event.inputSummary).toContain("npm test");
  });

  it("marks failure events as errors", () => {
    const event = mapPostToolUseInput({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_response: { error: "boom" },
    });

    expect(event.status).toBe("error");
  });
});
