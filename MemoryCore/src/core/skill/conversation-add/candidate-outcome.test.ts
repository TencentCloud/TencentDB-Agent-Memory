import { describe, expect, it } from "vitest";
import { summarizeCandidateOutcomes } from "./candidate-outcome.js";

describe("summarizeCandidateOutcomes", () => {
  it("separates creates from updates without retaining skill content", () => {
    expect(summarizeCandidateOutcomes([
      { action: "create", name: "new-skill", skill_id: "sk-1" },
      { action: "update", name: "old-skill", skill_id: "sk-2" },
      { action: "patch", name: "old-skill", skill_id: "sk-2" },
    ])).toEqual({
      total: 3,
      created: 1,
      updated: 2,
      nonCreate: 2,
      byAction: { create: 1, update: 1, patch: 1 },
    });
  });

  it("reports an empty extraction as zero candidates", () => {
    expect(summarizeCandidateOutcomes([])).toEqual({
      total: 0,
      created: 0,
      updated: 0,
      nonCreate: 0,
      byAction: {},
    });
  });
});
