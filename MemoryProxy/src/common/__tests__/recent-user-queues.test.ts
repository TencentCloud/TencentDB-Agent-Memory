import { describe, expect, it } from "vitest";
import { extractRecentUserQueues } from "../recent-user-queues.js";

const input = (text: string) => ({ type: "message", role: "user", content: text });

describe("extractRecentUserQueues", () => {
  it("keeps the latest queues in chronological order and ignores tools", () => {
    const result = extractRecentUserQueues([
      input("q1"),
      { type: "function_call", name: "tool" },
      input("q2"),
      input("q3"),
      input("q4"),
    ], (content) => typeof content === "string" ? content : null, 3);
    expect(result).toBe("q2\n\nq3\n\nq4");
  });

  it("bounds the query size", () => {
    const result = extractRecentUserQueues([input("12345"), input("67890")], (content) => String(content), 3, 6);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result).toBe("67890");
  });

  it("removes Proxy-owned Skill blocks before counting a queue", () => {
    const result = extractRecentUserQueues([
      input("old queue\n<!-- tdai:skill-queue:start -->\nold skills\n<!-- tdai:skill-queue:end -->"),
      input("latest queue"),
    ], (content) => typeof content === "string" ? content : null, 3);
    expect(result).toBe("old queue\n\nlatest queue");
  });

  it("does not return a queue that only contains a persisted Skill block", () => {
    const result = extractRecentUserQueues([
      input("<!-- tdai:skill-queue:start -->\nonly skills\n<!-- tdai:skill-queue:end -->"),
      input("real user query"),
    ], (content) => typeof content === "string" ? content : null, 1);
    expect(result).toBe("real user query");
  });
});
