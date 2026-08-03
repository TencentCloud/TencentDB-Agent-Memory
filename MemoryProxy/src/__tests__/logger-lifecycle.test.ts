import { describe, expect, it, vi } from "vitest";
import type { ILogBackend, LogConfig } from "../report/types.js";

function createBackend(type: string): ILogBackend {
  return {
    type,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const debugConfig: LogConfig = {
  level: "debug",
  filePath: "",
  rotate: {
    maxSizeBytes: 1024,
    backupLimit: 1,
  },
  backend: "noop",
};

describe("logger lifecycle", () => {
  it("ignores repeated initialization and shuts down the original backend", async () => {
    const { getLogLevel, initLogger, log, shutdownLogger } = await import("../report/log.js");
    const originalBackend = createBackend("original");
    const replacementBackend = createBackend("replacement");

    initLogger(debugConfig, originalBackend);
    initLogger({ ...debugConfig, level: "error" }, replacementBackend);
    log.info("still_original");

    expect(getLogLevel()).toBe("debug");
    expect(originalBackend.info).toHaveBeenCalledWith("still_original", {});
    expect(replacementBackend.info).not.toHaveBeenCalled();

    await shutdownLogger();

    expect(originalBackend.shutdown).toHaveBeenCalledOnce();
    expect(replacementBackend.shutdown).not.toHaveBeenCalled();
  });
});
