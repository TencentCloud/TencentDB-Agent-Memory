import { describe, expect, it } from "vitest";
import { boundSkillTrace, redactText, safeJson } from "../src/sanitize.js";

describe("capture sanitization", () => {
  it("removes recalled blocks and common credential shapes", () => {
    const value = redactText([
      "<tencentdb-agent-memory>ignore me</tencentdb-agent-memory>",
      "Authorization: Bearer abc.def",
      "API_KEY=super-secret",
      "https://alice:password@example.com/path",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ].join("\n"));
    expect(value).not.toContain("ignore me");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("alice:password");
    expect(value).not.toContain("\nabc\n");
  });

  it("redacts nested structured credentials", () => {
    const value = safeJson({ nested: { token: "secret", okay: "visible" } });
    expect(value).toContain("[REDACTED]");
    expect(value).not.toContain("secret");
    expect(value).toContain("visible");
  });

  it("never leaves an orphan tool call after bounding", () => {
    const bounded = boundSkillTrace([
      { role: "user", content: "question" },
      { role: "tool_call", content: "{}", tool_call_id: "c1", tool_name: "read" },
      { role: "tool_result", content: "x".repeat(2_000), tool_call_id: "c1", tool_name: "read" },
      { role: "assistant", content: "answer" },
    ], 300);
    expect(bounded.some((m) => m.role === "tool_call")).toBe(false);
  });
});
