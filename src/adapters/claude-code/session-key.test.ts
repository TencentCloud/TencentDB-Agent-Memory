import { describe, expect, it } from "vitest";
import { deriveClaudeCodeSessionKey, hashWorkspaceId } from "./session-key.js";

describe("Claude Code session key", () => {
  it("derives a stable agent-scoped key", () => {
    const key = deriveClaudeCodeSessionKey({
      cwd: "C:/Users/example/project",
      sessionId: "abc-123",
    });

    expect(key).toMatch(/^agent:claude-code-[a-f0-9]{10}:abc-123$/);
  });

  it("does not leak the raw workspace path", () => {
    const cwd = "C:/Users/example/secret-workspace";
    const key = deriveClaudeCodeSessionKey({ cwd, sessionId: "session" });

    expect(key).not.toContain("secret-workspace");
    expect(key).not.toContain("Users");
  });

  it("sanitizes unusual session ids", () => {
    const key = deriveClaudeCodeSessionKey({
      cwd: "C:/tmp/project",
      sessionId: "session id/with spaces",
    });

    expect(key.endsWith(":session-id-with-spaces")).toBe(true);
  });

  it("hashes the same cwd consistently", () => {
    expect(hashWorkspaceId("C:/tmp/project")).toBe(hashWorkspaceId("C:/tmp/project"));
  });
});

