/**
 * Tests for #766 — all diagnostic log levels must go to stderr so the MCP
 * stdio transport (which reads JSON-RPC from stdout) is never corrupted by
 * log lines.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger (#766)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info to stderr, never stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    createLogger("test").info("hello");

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("hello"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes debug to stderr, never stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    createLogger("test").debug("trace");

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("trace"));
    expect(stdout).not.toHaveBeenCalled();
  });
});
