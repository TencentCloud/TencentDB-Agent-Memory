import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLogger, defaultLogPaths } from "./file-logger.js";

describe("file logging outside containers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-file-log-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = (logPath: string, fallbackPath?: string) => ({
    path: logPath, fallbackPath, filename: "core.log", rotateSizeBytes: 100,
    rotateBackupLimit: 2,
  });

  it("falls back after a directory error and still rotates the real file", () => {
    const blocked = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocked, "blocked");
    const fallback = path.join(dir, "logs");
    const logger = new FileLogger(config(path.join(blocked, "log"), fallback));
    logger.write("INFO", "first-record");
    logger.write("INFO", "second-record".repeat(5));
    const names = fs.readdirSync(fallback);
    expect(names.filter(name => name.startsWith("core.log."))).toHaveLength(1);
    expect(fs.readFileSync(path.join(fallback, "core.log"), "utf8")).toContain("second-record");
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("using " + fallback));
  });
  it("retains a working primary directory", () => {
    const primary = path.join(dir, "primary");
    const fallback = path.join(dir, "fallback");
    new FileLogger(config(primary, fallback)).write("INFO", "container");
    expect(fs.readFileSync(path.join(primary, "core.log"), "utf8")).toContain("container");
    expect(fs.existsSync(fallback)).toBe(false);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
  it("detects a non-writable log target even when the directory can be created", () => {
    const primary = path.join(dir, "primary");
    fs.mkdirSync(path.join(primary, "core.log"), { recursive: true });
    const fallback = path.join(dir, "fallback");
    new FileLogger(config(primary, fallback)).write("WARN", "fallback record");
    expect(fs.readFileSync(path.join(fallback, "core.log"), "utf8")).toContain("fallback record");
  });
  it("warns and stays nonfatal when both destinations fail", () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "blocked");
    const logger = new FileLogger(config(path.join(blocked, "one"), path.join(blocked, "two")));
    expect(() => logger.write("ERROR", "still running")).not.toThrow();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("file logging disabled"));
  });
  it("never substitutes a caller's explicit LOG_PATH", () => {
    vi.stubEnv("LOG_PATH", path.join(dir, "explicit"));
    expect(defaultLogPaths()).toEqual({ path: path.join(dir, "explicit") });
  });
  it("uses the configured application root for the host fallback", () => {
    vi.stubEnv("LOG_PATH", "");
    vi.stubEnv("MEMORY_TENCENTDB_ROOT", dir);
    expect(defaultLogPaths()).toEqual({ path: "/data/log/", fallbackPath: path.join(dir, "logs") });
  });
});
