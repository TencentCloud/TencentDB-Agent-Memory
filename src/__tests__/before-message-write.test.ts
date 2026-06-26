import { describe, it, expect, vi } from "vitest";
import { maybeStripRelevantMemoriesOnWrite } from "../../index.js";

describe("maybeStripRelevantMemoriesOnWrite", () => {
  it("returns null when TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE is unset", () => {
    const msg = {
      role: "user",
      content: "hello <relevant-memories>foo</relevant-memories> world",
    };
    expect(maybeStripRelevantMemoriesOnWrite(msg)).toBeNull();
  });

  it("strips <relevant-memories> from string content when env=1", () => {
    vi.stubEnv("TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE", "1");
    const msg = {
      role: "user",
      content:
        "hello <relevant-memories>foo bar baz</relevant-memories> world",
    };
    const result = maybeStripRelevantMemoriesOnWrite(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("hello world");
  });

  it("strips <relevant-memories> from one part of array content when env=1", () => {
    vi.stubEnv("TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE", "1");
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "before <relevant-memories>x</relevant-memories>" },
        { type: "image", url: "https://example.com/cat.png" },
        { type: "text", text: "after (no memories here)" },
      ],
    };
    const result = maybeStripRelevantMemoriesOnWrite(msg);
    expect(result).not.toBeNull();
    const parts = result!.content as Array<{ type: string; text?: string; url?: string }>;
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toBe("before");
    expect(parts[1].url).toBe("https://example.com/cat.png");
    expect(parts[2].text).toBe("after (no memories here)");
  });

  it("does not touch assistant-role messages even when env=1", () => {
    vi.stubEnv("TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE", "1");
    const msg = {
      role: "assistant",
      content: "ok <relevant-memories>x</relevant-memories>",
    };
    expect(maybeStripRelevantMemoriesOnWrite(msg)).toBeNull();
  });

  it("returns null when user message has no <relevant-memories> tag (env=1)", () => {
    vi.stubEnv("TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE", "1");
    const msg = { role: "user", content: "just a plain message" };
    expect(maybeStripRelevantMemoriesOnWrite(msg)).toBeNull();
  });

  it.each(["true", "yes", "0", "1 ", "", "TRUE"])(
    "treats env=%j (anything but literal '1') as unset",
    (envValue) => {
      vi.stubEnv("TDAI_STRIP_RELEVANT_MEMORIES_ON_WRITE", envValue);
      const msg = {
        role: "user",
        content: "<relevant-memories>x</relevant-memories>",
      };
      expect(maybeStripRelevantMemoriesOnWrite(msg)).toBeNull();
    },
  );
});
