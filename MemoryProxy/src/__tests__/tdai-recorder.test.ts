import { describe, expect, it } from "vitest";
import { extractLatestUserMessage } from "../tdai/recorder.js";

describe("extractLatestUserMessage", () => {
  it("does not fall back to an older turn when the latest user message is harness noise", () => {
    const result = extractLatestUserMessage([
      { role: "user", content: "earlier real question" },
      { role: "assistant", content: "earlier answer" },
      {
        role: "user",
        content: "<system-reminder>metadata only</system-reminder>",
      },
    ]);

    expect(result).toBeNull();
  });

  it("still extracts the newest real user message past trailing assistant messages", () => {
    const result = extractLatestUserMessage([
      { role: "user", content: "older question" },
      { role: "user", content: "<user_query>new question</user_query>" },
      { role: "assistant", content: "pending answer" },
    ]);

    expect(result).toEqual({ role: "user", content: "new question" });
  });
});
