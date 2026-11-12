import { describe, expect, it, vi } from "vitest";
import { resolveSkillConfig } from "./skill-config.js";

const probe = { hasTcvdbCredentials: false, hasCosCredentials: false, embeddingAvailable: false, llmRunnerAvailable: true };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("semantic restructuring configuration", () => {
  it("enables semantic review with separate whole-package thresholds and bounded budgets", () => {
    const config = resolveSkillConfig({ enabled: true }, probe, logger)!;
    expect(config.restructure).toMatchObject({ enabled: true, bodyReviewChars: 24_000, packageTextReviewBytes: 64_000, resourceReviewCount: 60, maxAttempts: 2 });
    expect(config.restructure?.budgets.deadlineMs).toBe(600_000);
  });

  it("accepts explicit disable and merges budget overrides without mutating defaults", () => {
    const config = resolveSkillConfig({ enabled: true, restructure: { enabled: false, bodyReviewChars: 18_000, budgets: { maxCalls: 4 } } }, probe, logger)!;
    expect(config.restructure).toMatchObject({ enabled: false, bodyReviewChars: 18_000, budgets: { maxCalls: 4, deadlineMs: 600_000 } });
    expect(resolveSkillConfig({ enabled: true }, probe, logger)!.restructure?.bodyReviewChars).toBe(24_000);
  });

  it("does not construct a skill runtime when the skill module is disabled", () => {
    expect(resolveSkillConfig({ enabled: false }, probe, logger)).toBeNull();
  });
});
