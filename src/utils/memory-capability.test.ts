import { describe, expect, it, vi } from "vitest";

import { registerMemoryCapabilityIfAvailable } from "./memory-capability.js";

describe("registerMemoryCapabilityIfAvailable", () => {
  it("registers an empty memory capability when the host supports it", () => {
    const registerMemoryCapability = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const registered = registerMemoryCapabilityIfAvailable(
      { registerMemoryCapability },
      logger,
    );

    expect(registered).toBe(true);
    expect(registerMemoryCapability).toHaveBeenCalledWith({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips older hosts without failing plugin registration", () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const registered = registerMemoryCapabilityIfAvailable({}, logger);

    expect(registered).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("registerMemoryCapability unavailable"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats host registration failures as non-fatal", () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const registerMemoryCapability = vi.fn(() => {
      throw new Error("slot loader rejected plugin");
    });

    const registered = registerMemoryCapabilityIfAvailable(
      { registerMemoryCapability },
      logger,
    );

    expect(registered).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("slot loader rejected plugin"),
    );
  });
});
