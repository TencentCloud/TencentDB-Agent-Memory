import { describe, expect, it } from "vitest";
import { extractClientIdentity } from "../../identity.js";
import { derivePiSessionId } from "../pi.js";

describe("Pi branch-scoped session identity", () => {
  it("derives distinct identities for two tree branches in the same Pi session", () => {
    const commonHeaders = {
      authorization: "Bearer usr_test.secret",
      "x-conversation-id": "pi-session-123",
    };

    const left = extractClientIdentity(
      { ...commonHeaders, "x-tdai-memory-branch": "branch-left" },
      undefined,
      "pi",
    );
    const right = extractClientIdentity(
      { ...commonHeaders, "x-tdai-memory-branch": "branch-right" },
      undefined,
      "pi",
    );

    expect(left.sessionId).toBe("pi-session-123-branch-left");
    expect(right.sessionId).toBe("pi-session-123-branch-right");
    expect(left.sessionId).not.toBe(right.sessionId);
  });

  it("preserves the post-#1126 identity exactly when the marker is absent", () => {
    const identity = extractClientIdentity(
      {
        authorization: "Bearer usr_test.secret",
        "x-conversation-id": "pi-session-legacy",
      },
      undefined,
      "pi",
    );

    expect(identity.sessionId).toBe("pi-session-legacy");
  });

  it("falls back for malformed markers and ignores Pi markers for other clients", () => {
    expect(derivePiSessionId("pi-session-legacy", "bad marker")).toBe("pi-session-legacy");

    const nonPi = extractClientIdentity(
      {
        authorization: "Bearer usr_test.secret",
        "x-conversation-id": "session-other-client",
        "x-tdai-memory-branch": "branch-left",
      },
      undefined,
      "codebuddy",
    );
    expect(nonPi.sessionId).toBe("session-other-client");
  });

  it("treats the branch routing header as case-insensitive", () => {
    const identity = extractClientIdentity(
      {
        authorization: "Bearer usr_test.secret",
        "X-TDAI-Memory-Branch": "branch-uppercase",
        "x-conversation-id": "pi-session-123",
      },
      undefined,
      "pi",
    );
    expect(identity.sessionId).toBe("pi-session-123-branch-uppercase");
  });

  it("derives the same identity on every machine for the same persisted marker", () => {
    expect(derivePiSessionId("pi-session-123", "branch-stable")).toBe(
      derivePiSessionId("pi-session-123", "branch-stable"),
    );
  });
});
