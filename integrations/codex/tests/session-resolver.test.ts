import { describe, expect, it } from "vitest";
import { sanitizeSessionKey, SessionResolver } from "../src/session-resolver.js";

describe("SessionResolver", () => {
  it("prioritizes a tool-provided session key", () => {
    const resolver = new SessionResolver({ explicitSessionKey: "configured key" });
    expect(resolver.resolve("tool/session key")).toBe("tool-session-key");
  });

  it("uses explicit configured values before workspace discovery", () => {
    const resolver = new SessionResolver({ explicitSessionKey: "configured key" });
    expect(resolver.resolve()).toBe("configured-key");
  });

  it("sanitizes and limits keys", () => {
    expect(sanitizeSessionKey("  hello / 世界  ")).toBe("hello");
    expect(sanitizeSessionKey("x".repeat(300))).toHaveLength(160);
  });
});
