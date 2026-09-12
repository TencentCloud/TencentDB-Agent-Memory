import { describe, expect, it } from "vitest";
import { derivePiAgentSessionKey } from "./session-key.js";

describe("derivePiAgentSessionKey", () => {
  it("is stable for the same workspace/session/user", () => {
    const input = { workspace: "D:/repo", sessionId: "s1", userId: "u1" };
    expect(derivePiAgentSessionKey(input)).toBe(derivePiAgentSessionKey(input));
  });

  it("separates different workspaces", () => {
    const a = derivePiAgentSessionKey({ workspace: "D:/repo-a", sessionId: "s1", userId: "u1" });
    const b = derivePiAgentSessionKey({ workspace: "D:/repo-b", sessionId: "s1", userId: "u1" });
    expect(a).not.toBe(b);
    expect(a.startsWith("pi-agent:")).toBe(true);
  });
});