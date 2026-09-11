import { describe, expect, it } from "vitest";
import {
  stripRelevantMemoriesFromContentParts,
  stripRelevantMemoriesFromText,
} from "./recall-context.js";

describe("recall context cleanup", () => {
  it("strips injected relevant memories from string user content", () => {
    const cleaned = stripRelevantMemoriesFromText(
      "<relevant-memories>\n- [episodic] dynamic memory\n</relevant-memories>\n\nWhat changed?",
    );

    expect(cleaned).toBe("What changed?");
  });

  it("leaves content without injected memories unchanged", () => {
    expect(stripRelevantMemoriesFromText("What changed?")).toBe("What changed?");
  });

  it("strips injected relevant memories from text content parts only", () => {
    const image = { type: "image", source: "data:image/png;base64,abc" };
    const { parts, strippedChars } = stripRelevantMemoriesFromContentParts([
      {
        type: "text",
        text: "<relevant-memories>\n- [instruction] dynamic memory\n</relevant-memories>\n\nPlease continue.",
      },
      image,
    ]);

    expect(parts).toEqual([
      { type: "text", text: "Please continue." },
      image,
    ]);
    expect(strippedChars).toBeGreaterThan(0);
  });
});
