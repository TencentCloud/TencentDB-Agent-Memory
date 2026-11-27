import { describe, expect, it } from "vitest";

import { parseSessionRowId } from "../sessionRepo.js";

describe("parseSessionRowId", () => {
  it("hydrates legacy three-part session ids into the default space", () => {
    expect(parseSessionRowId("user-1:claude-code:session-1", "session-1")).toEqual({
      spaceId: "_default",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session-1",
    });
  });

  it("preserves legacy session ids containing colons", () => {
    expect(
      parseSessionRowId("user-1:claude-code:session:part-2", "session:part-2"),
    ).toEqual({
      spaceId: "_default",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session:part-2",
    });
  });

  it("keeps current four-part session ids unchanged", () => {
    expect(
      parseSessionRowId(
        "space-1:user-1:claude-code:session:part-2",
        "session:part-2",
      ),
    ).toEqual({
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "claude-code",
      sessionId: "session:part-2",
    });
  });
});
