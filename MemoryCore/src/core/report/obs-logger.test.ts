import { describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  getObservabilityBackend: () => ({ log: backend }),
}));

vi.mock("./file-logger.js", () => ({
  FileLogger: class {
    write() {}
  },
}));

import { obsLogger } from "./obs-logger.js";

describe("obsLogger", () => {
  it("routes high-frequency worker diagnostics to the debug backend", () => {
    obsLogger.debug("skill.worker.acquire_lock", { acquired: false });

    expect(backend.debug).toHaveBeenCalledWith("skill.worker.acquire_lock", { acquired: false });
    expect(backend.info).not.toHaveBeenCalled();
  });
});
