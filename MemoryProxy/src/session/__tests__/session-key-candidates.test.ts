import { describe, expect, it } from "vitest";

import { AGENT_KINDS } from "../../agent-adapters/types.js";
import { resolveSessionFromL1, sessionKeyCandidates } from "../session-key-candidates.js";

describe("sessionKeyCandidates", () => {
  it("includes every registered agent source for bare session IDs", () => {
    const sessionId = "pi-session-123";

    expect(sessionKeyCandidates(sessionId)).toEqual([
      sessionId,
      ...AGENT_KINDS.map((agentSource) => `${agentSource}:${sessionId}`),
    ]);
    expect(sessionKeyCandidates(sessionId)).toContain(`pi:${sessionId}`);
  });

  it("preserves an already composite session key", () => {
    expect(sessionKeyCandidates("pi:pi-session-123")).toEqual(["pi:pi-session-123"]);
  });

  it("resolves a Pi session from L1 without an L2 fallback", () => {
    const sessionId = "pi-session-123";
    const states = new Map([[`pi:${sessionId}`, { initialized: true }]]);

    const resolved = resolveSessionFromL1(
      sessionId,
      (key) => states.get(key),
      (state, key) => (state?.initialized ? { key } : null),
    );

    expect(resolved).toEqual({ key: `pi:${sessionId}` });
  });
});
