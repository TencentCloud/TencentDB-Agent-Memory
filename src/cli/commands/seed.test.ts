import { describe, expect, it } from "vitest";

import { validateSeedOutputPlan } from "./seed.js";

const validResume = {
  resume: true,
  hasExplicitOutputDir: true,
  inputHasTimestamps: true,
  outputDirExists: true,
  checkpointExists: true,
  outputDirEmpty: false,
  outputDir: "/tmp/seed-output",
};

describe("validateSeedOutputPlan", () => {
  it("accepts an explicit checkpoint resume with stable input timestamps", () => {
    expect(validateSeedOutputPlan(validResume)).toBeUndefined();
  });

  it("requires an explicit output directory for resume", () => {
    expect(
      validateSeedOutputPlan({
        ...validResume,
        hasExplicitOutputDir: false,
      }),
    ).toContain("--resume requires an explicit --output-dir");
  });

  it("rejects resume when timestamps would be regenerated", () => {
    expect(
      validateSeedOutputPlan({
        ...validResume,
        inputHasTimestamps: false,
      }),
    ).toContain("stable timestamps");
  });

  it("requires an existing directory and checkpoint for resume", () => {
    expect(
      validateSeedOutputPlan({
        ...validResume,
        outputDirExists: false,
        checkpointExists: false,
      }),
    ).toContain("does not exist");

    expect(
      validateSeedOutputPlan({
        ...validResume,
        checkpointExists: false,
      }),
    ).toContain("checkpoint not found");
  });

  it("preserves the existing fail-safe behavior without --resume", () => {
    expect(
      validateSeedOutputPlan({
        ...validResume,
        resume: false,
      }),
    ).toContain("already contains a checkpoint");

    expect(
      validateSeedOutputPlan({
        ...validResume,
        resume: false,
        checkpointExists: false,
      }),
    ).toContain("already exists and is not empty");
  });

  it("allows a new or empty output directory without --resume", () => {
    expect(
      validateSeedOutputPlan({
        ...validResume,
        resume: false,
        outputDirExists: false,
        checkpointExists: false,
        outputDirEmpty: true,
      }),
    ).toBeUndefined();

    expect(
      validateSeedOutputPlan({
        ...validResume,
        resume: false,
        checkpointExists: false,
        outputDirEmpty: true,
      }),
    ).toBeUndefined();
  });
});
