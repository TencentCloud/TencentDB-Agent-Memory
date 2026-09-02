import { describe, expect, it } from "vitest";
import { createQwenCodeSessionKey, getProjectIdForQwenCode } from "./session-key.js";

describe("Qwen Code session key", () => {
  it("uses explicit session key overrides", () => {
    expect(
      createQwenCodeSessionKey({
        cwd: "/repo/project",
        sessionId: "session-1",
        explicitSessionKey: "custom-key",
      }),
    ).toBe("custom-key");
  });

  it("creates stable project-scoped keys without exposing full paths", () => {
    const key = createQwenCodeSessionKey({
      cwd: "/Users/alice/work/demo",
      sessionId: "session-1",
    });

    expect(key).toMatch(/^qwen:demo-[a-f0-9]{12}:[a-f0-9]{10}$/);
    expect(key).not.toContain("/Users/alice/work");
    expect(
      createQwenCodeSessionKey({
        cwd: "/Users/alice/work/demo",
        sessionId: "session-1",
      }),
    ).toBe(key);
  });

  it("normalizes Windows-style project paths consistently", () => {
    const first = getProjectIdForQwenCode("C:\\Users\\Alice\\Demo\\");
    const second = getProjectIdForQwenCode("c:/users/alice/demo");
    expect(first).toBe(second);
  });
});

