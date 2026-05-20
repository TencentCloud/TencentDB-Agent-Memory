import { describe, expect, it } from "vitest";
import { validateAndNormalizeRaw, SeedValidationError } from "./input.js";

describe("seed input normalization", () => {
  it("preserves stable message IDs for idempotent imports", () => {
    const input = validateAndNormalizeRaw({
      sessions: [{
        sessionKey: "codex-import:test",
        sessionId: "session-1",
        conversations: [[
          { id: "msg-user-1", role: "user", content: "hello", timestamp: 1 },
          { id: "msg-assistant-1", role: "assistant", content: "hi", timestamp: 2 },
        ]],
      }],
    }, { strictRoundRole: true, autoFillTimestamps: false });

    expect(input.sessions[0]!.rounds[0]!.messages.map((msg) => msg.id)).toEqual([
      "msg-user-1",
      "msg-assistant-1",
    ]);
  });

  it("rejects empty message IDs when provided", () => {
    expect(() => validateAndNormalizeRaw({
      sessions: [{
        sessionKey: "codex-import:test",
        conversations: [[
          { id: "", role: "user", content: "hello", timestamp: 1 },
          { role: "assistant", content: "hi", timestamp: 2 },
        ]],
      }],
    }, { strictRoundRole: true, autoFillTimestamps: false })).toThrow(SeedValidationError);
  });
});
