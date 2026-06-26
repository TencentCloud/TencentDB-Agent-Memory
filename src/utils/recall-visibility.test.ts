import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { stripRelevantMemoriesFromContent } from "./recall-visibility.js";

describe("recall.showInjected", () => {
  it("defaults to hiding injected recall context", () => {
    expect(parseConfig({}).recall.showInjected).toBe(false);
  });

  it("can preserve injected recall context for visible history", () => {
    expect(parseConfig({ recall: { showInjected: true } }).recall.showInjected).toBe(true);

    const content = "hello\n<relevant-memories>\nremembered fact\n</relevant-memories>";
    const result = stripRelevantMemoriesFromContent(content, { showInjected: true });

    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("strips injected recall context when visibility is disabled", () => {
    const result = stripRelevantMemoriesFromContent(
      "hello\n<relevant-memories>\nremembered fact\n</relevant-memories>",
      { showInjected: false },
    );

    expect(result.changed).toBe(true);
    expect(result.content).toBe("hello");
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it("strips injected recall context from text parts only", () => {
    const result = stripRelevantMemoriesFromContent(
      [
        { type: "text", text: "hello\n<relevant-memories>x</relevant-memories>" },
        { type: "image", imageUrl: "file://example.png" },
      ],
      { showInjected: false },
    );

    expect(result.changed).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", imageUrl: "file://example.png" },
    ]);
  });
});
