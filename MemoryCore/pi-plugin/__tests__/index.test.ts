import { afterEach, describe, expect, it, vi } from "vitest";

import extension from "../index.js";

const requiredEnv = {
  TDAI_USER_KEY: "test-user-key",
  TDAI_TEAM_ID: "test-team",
  TDAI_AGENT_ID: "test-agent",
};

function makePi() {
  return {
    on: vi.fn(),
    registerProvider: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Pi TDAI provider", () => {
  it("uses the system role for proxy-routed reasoning models", () => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      vi.stubEnv(key, value);
    }
    const pi = makePi();

    extension(pi as any);

    expect(pi.registerProvider).toHaveBeenCalledWith(
      "tdai",
      expect.objectContaining({
        models: [
          expect.objectContaining({
            compat: { supportsDeveloperRole: false },
          }),
        ],
      }),
    );
  });
});
