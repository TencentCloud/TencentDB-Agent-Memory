import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSkillConfig } from "./skill-config.js";
import type { SkillConfigInput, SkillEnvProbe } from "./types.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const probe: SkillEnvProbe = {
  outerStoreBackend: "sqlite",
  hasTcvdbCredentials: false,
  hasCosCredentials: false,
  embeddingAvailable: false,
  llmRunnerAvailable: false,
};

const input: SkillConfigInput = {
  enabled: true,
  extraction: { enabled: false },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("skill worker concurrency", () => {
  it("defaults to a bounded pool for an idle single-agent deployment", () => {
    vi.stubEnv("TDAI_SKILL_WORKER_CONCURRENCY", "");

    const resolved = resolveSkillConfig(input, probe, logger);

    expect(resolved?.worker.concurrency).toBe(4);
  });

  it("keeps explicit environment overrides for fan-out deployments", () => {
    vi.stubEnv("TDAI_SKILL_WORKER_CONCURRENCY", "12");

    const resolved = resolveSkillConfig(input, probe, logger);

    expect(resolved?.worker.concurrency).toBe(12);
  });
});
