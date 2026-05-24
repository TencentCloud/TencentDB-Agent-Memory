import { describe, expect, it } from "vitest";

import { shouldPassExtraSystemPrompt } from "./clean-context-runner.js";

describe("shouldPassExtraSystemPrompt", () => {
  it("keeps the legacy fallback when the OpenClaw version is unknown", () => {
    expect(shouldPassExtraSystemPrompt(undefined)).toBe(true);
    expect(shouldPassExtraSystemPrompt("unknown")).toBe(true);
  });

  it("keeps the fallback for OpenClaw versions before 2026.4.7", () => {
    expect(shouldPassExtraSystemPrompt("2026.4.6")).toBe(true);
  });

  it("omits the fallback for OpenClaw versions that support systemPromptOverride", () => {
    expect(shouldPassExtraSystemPrompt("2026.4.7")).toBe(false);
    expect(shouldPassExtraSystemPrompt("2026.4.7-beta.1")).toBe(false);
    expect(shouldPassExtraSystemPrompt("2026.5.20")).toBe(false);
  });
});
