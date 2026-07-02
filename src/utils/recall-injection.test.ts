import { describe, expect, it } from "vitest";
import {
  stripInjectedRecallFromMessage,
  stripInjectedRecallText,
} from "./recall-injection.js";

// ============================
// stripInjectedRecallText (low-level)
// ============================

describe("stripInjectedRecallText", () => {
  it("removes <relevant-memories> block from text", () => {
    const input = `<relevant-memories>
- [instruction] User prefers concise updates.
- [episodic] User mentioned a vacation plan.
</relevant-memories>
Please summarize the task.`;
    expect(stripInjectedRecallText(input)).toBe("Please summarize the task.");
  });

  it("returns original text if no tag present", () => {
    const input = "Hello, how are you?";
    expect(stripInjectedRecallText(input)).toBe("Hello, how are you?");
  });

  it("handles empty string", () => {
    expect(stripInjectedRecallText("")).toBe("");
  });

  it("removes trailing whitespace after close tag", () => {
    const input = "<relevant-memories>content</relevant-memories>   \n  Hello";
    expect(stripInjectedRecallText(input)).toBe("Hello");
  });

  it("handles multiple relevant-memories blocks", () => {
    const input =
      "<relevant-memories>first</relevant-memories>\n" +
      "middle\n" +
      "<relevant-memories>second</relevant-memories>\n" +
      "after";
    expect(stripInjectedRecallText(input)).toBe("middle\nafter");
  });

  it("returns empty string when only the tag block is present", () => {
    const input = "<relevant-memories>some memory</relevant-memories>";
    expect(stripInjectedRecallText(input)).toBe("");
  });

  it("handles nested angle brackets inside content (not true XML)", () => {
    const input =
      "<relevant-memories>User said: 3 > 2 and 2 < 3</relevant-memories>\nReminder";
    expect(stripInjectedRecallText(input)).toBe("Reminder");
  });

  it("preserves text before the tag block", () => {
    const input = "prefix text <relevant-memories>memory</relevant-memories>";
    expect(stripInjectedRecallText(input)).toBe("prefix text");
  });

  it("handles content with newlines and special characters", () => {
    const input =
      "action: <relevant-memories>记忆包含中文、English、emoji 🎉\n以及换行</relevant-memories>\n  execute()";
    expect(stripInjectedRecallText(input)).toBe("action: execute()");
  });
});

// ============================
// stripInjectedRecallFromMessage (MessageLike interface)
// ============================

describe("stripInjectedRecallFromMessage", () => {
  // ── Role filtering ──

  it("returns undefined for non-user messages", () => {
    const msg = { role: "assistant", content: "<relevant-memories>data</relevant-memories>" };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  it("returns undefined for system messages", () => {
    const msg = { role: "system", content: "<relevant-memories>data</relevant-memories>" };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  // ── String content ──

  it("strips <relevant-memories> from a user string message", () => {
    const msg = {
      role: "user",
      content: "<relevant-memories>\n- [instruction] Be concise.\n</relevant-memories>\nWhat's the weather?",
    };
    const result = stripInjectedRecallFromMessage(msg);
    expect(result).toBeDefined();
    expect(result!.content).toBe("What's the weather?");
  });

  it("returns undefined when user string has no tag", () => {
    const msg = { role: "user", content: "Hello world" };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  it("preserves the rest of the message fields", () => {
    const msg = {
      role: "user",
      content: "<relevant-memories>x</relevant-memories>\nhello",
      id: "msg-123",
      extra: { source: "webchat" },
    };
    const result = stripInjectedRecallFromMessage(msg);
    expect(result).toBeDefined();
    expect(result!.content).toBe("hello");
    expect((result as Record<string, unknown>).id).toBe("msg-123");
    expect((result as Record<string, unknown>).extra).toEqual({ source: "webchat" });
  });

  // ── Part-based content (TextContent[]) ──

  it("strips from a text part in an array", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "<relevant-memories>memory</relevant-memories>\nActual question?" },
      ],
    };
    const result = stripInjectedRecallFromMessage(msg);
    expect(result).toBeDefined();
    expect(Array.isArray(result!.content)).toBe(true);
    expect((result!.content as Array<Record<string, unknown>>)[0].text).toBe("Actual question?");
  });

  it("leaves non-text parts (images) untouched", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "<relevant-memories>memory</relevant-memories>\nTell me about this image" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc==" } },
      ],
    };
    const result = stripInjectedRecallFromMessage(msg);
    expect(result).toBeDefined();
    const parts = result!.content as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe("Tell me about this image");
    expect(parts[1].type).toBe("image");
    expect((parts[1].source as Record<string, unknown>).data).toBe("abc==");
  });

  it("returns undefined when no text part contains the tag", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "plain text" },
        { type: "image", source: { data: "img" } },
      ],
    };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  it("handles empty parts array", () => {
    const msg = { role: "user", content: [] };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  // ── Unknown / malformed content ──

  it("returns undefined for non-string, non-array content", () => {
    const msg = { role: "user", content: 42 as unknown as string };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  it("returns undefined for null content", () => {
    const msg = { role: "user", content: null as unknown as string };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  it("returns undefined for undefined content", () => {
    const msg = { role: "user" };
    expect(stripInjectedRecallFromMessage(msg)).toBeUndefined();
  });

  // ── Edge: multiple text parts, some with tags ──

  it("strips from multiple affected text parts", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "<relevant-memories>mem1</relevant-memories>\nQ1?" },
        { type: "text", text: "<relevant-memories>mem2</relevant-memories>\nQ2?" },
      ],
    };
    const result = stripInjectedRecallFromMessage(msg);
    expect(result).toBeDefined();
    const parts = result!.content as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe("Q1?");
    expect(parts[1].text).toBe("Q2?");
  });
});
