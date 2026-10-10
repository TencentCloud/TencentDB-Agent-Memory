import { describe, expect, it } from "vitest";
import { extractLatestUserMessage } from "../recorder.js";

describe("extractLatestUserMessage", () => {
  it("walks past a Claude Code tool result to the latest real user query", () => {
    expect(extractLatestUserMessage([
      { role: "user", content: "<user_query>Open the config file</user_query>" },
      { role: "assistant", content: "I will inspect it." },
      {
        role: "user",
        content: [
          { type: "text", text: "<tool_result>config contents...</tool_result>" },
        ],
      },
    ])).toEqual({ role: "user", content: "Open the config file" });
  });

  it("returns null when all trailing user messages are harness output", () => {
    expect(extractLatestUserMessage([
      { role: "assistant", content: "done" },
      { role: "user", content: "<tool_result>command output</tool_result>" },
    ])).toBeNull();
  });
});
