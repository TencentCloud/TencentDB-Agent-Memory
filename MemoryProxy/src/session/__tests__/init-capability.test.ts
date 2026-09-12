import { describe, expect, it } from "vitest";

import { resolveSessionInitCapability } from "../init-capability.js";

describe("resolveSessionInitCapability", () => {
  it.each([
    ["missing", undefined],
    ["non-array", {}],
    ["empty", []],
    ["without clarify", [{ type: "function", function: { name: "terminal" } }]],
  ])("treats Hermes %s tools as non-interactive", (_label, tools) => {
    expect(resolveSessionInitCapability("hermes", tools)).toEqual({
      canInteractiveInit: false,
    });
  });

  it("recognizes Hermes clarify", () => {
    expect(resolveSessionInitCapability("hermes", [
      { type: "function", function: { name: "clarify" } },
    ])).toEqual({
      canInteractiveInit: true,
      interactiveTool: "clarify",
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["without ask_user_question", [{ name: "terminal" }]],
  ])("treats dsh %s tools as non-interactive", (_label, tools) => {
    expect(resolveSessionInitCapability("dsh", tools)).toEqual({
      canInteractiveInit: false,
    });
  });

  it("recognizes dsh ask_user_question", () => {
    expect(resolveSessionInitCapability("dsh", [
      { name: "ask_user_question" },
    ])).toEqual({
      canInteractiveInit: true,
      interactiveTool: "ask_user_question",
    });
  });

  it("preserves interactive behavior for other agents", () => {
    expect(resolveSessionInitCapability("codebuddy", undefined)).toEqual({
      canInteractiveInit: true,
    });
  });
});
