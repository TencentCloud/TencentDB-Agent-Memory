import { describe, expect, it } from "vitest";

import { extractUserQueryText } from "../user-query-extractor.js";
import { extractLatestUserMessage } from "../../tdai/recorder.js";

const skillBlock =
  '<skill_content name="review-helper">\nfull harness-injected skill instructions\n</skill_content>';

describe("user-query-extractor skill metadata", () => {
  it("drops a standalone skill content block", () => {
    expect(extractUserQueryText(skillBlock)).toBe("");
  });

  it("does not write a trailing skill block as the user message", () => {
    const message = extractLatestUserMessage([
      { role: "user", content: "Please review this change." },
      { role: "user", content: skillBlock },
    ]);

    expect(message).toEqual({
      role: "user",
      content: "Please review this change.",
    });
  });

  it("keeps real text merged with a skill content block", () => {
    expect(extractUserQueryText(`Please review this change.\n${skillBlock}`)).toBe(
      "Please review this change.",
    );
  });

  it("does not discard lookalike user text without a complete skill tag", () => {
    expect(extractUserQueryText("<skill_contentious>literal user text")).toBe(
      "<skill_contentious>literal user text",
    );
  });
});
