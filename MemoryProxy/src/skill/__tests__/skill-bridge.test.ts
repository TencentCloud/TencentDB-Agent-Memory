import { describe, expect, it } from "vitest";
import { skillBridgeSessionCandidates } from "../skill-bridge.js";

describe("skill bridge session lookup", () => {
  it("includes the Codex namespace used by WorkBuddy session initialization", () => {
    expect(skillBridgeSessionCandidates("session-1")).toEqual([
      "session-1",
      "codebuddy:session-1",
      "claude-code:session-1",
      "codex:session-1",
    ]);
  });

  it("does not prefix an already composite session key", () => {
    expect(skillBridgeSessionCandidates("codex:session-1")).toEqual([
      "codex:session-1",
    ]);
  });
});
