import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "./console-logger.js";

describe("createConsoleLogger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("logs every level by default", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createConsoleLogger("[test]");

    logger.debug?.("debug message");
    logger.info?.("info message");
    logger.warn?.("warn message");
    logger.error?.("error message");

    expect(debug).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it("filters messages below LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createConsoleLogger("[test]");

    logger.debug?.("debug message");
    logger.info?.("info message");
    logger.warn?.("warn message");
    logger.error?.("error message");

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it("accepts a case-insensitive LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", " ERROR ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createConsoleLogger("[test]");

    logger.warn?.("warn message");
    logger.error?.("error message");

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});
