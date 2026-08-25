import { describe, expect, it, vi } from "vitest";
import { ensurePluginHookPolicy } from "./ensure-hook-policy.js";

describe("ensurePluginHookPolicy diagnostics", () => {
  it("reports when the hook policy is already enabled", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    ensurePluginHookPolicy({
      rootConfig: {
        plugins: {
          entries: {
            "memory-tencentdb": { hooks: { allowConversationAccess: true } },
          },
        },
      },
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("allowConversationAccess is already active"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
