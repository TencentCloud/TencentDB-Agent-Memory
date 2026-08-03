/**
 * Unit tests for createDevLogger: debug gating + file sink.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevLogger, resolveLogFile, flushLogs } from "./dev-logger.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-logger-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.TDAI_DEV = "";
});

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
  delete process.env.TDAI_DEV;
});

function readLog(dir: string): string {
  const file = resolveLogFile(dir);
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

describe("createDevLogger", () => {
  it("writes debug to file only in dev mode", async () => {
    const dir = makeTmpDir();

    const devLogger = createDevLogger({ tag: "[t]", logDir: dir, dev: true });
    devLogger.debug?.("debug line");
    devLogger.info("info line");
    await flushLogs();

    expect(readLog(dir)).toContain("[DEBUG] debug line");
    expect(readLog(dir)).toContain("[INFO] info line");
  });

  it("hides debug when dev is off", async () => {
    const dir = makeTmpDir();

    const prodLogger = createDevLogger({ tag: "[t]", logDir: dir, dev: false });
    prodLogger.debug?.("debug line");
    prodLogger.warn("warn line");
    await flushLogs();

    const log = readLog(dir);
    expect(log).not.toContain("[DEBUG] debug line");
    expect(log).toContain("[WARN] warn line");
  });

  it("respects TDAI_DEV=1 env when dev flag is omitted", async () => {
    const dir = makeTmpDir();
    process.env.TDAI_DEV = "1";

    const envLogger = createDevLogger({ tag: "[t]", logDir: dir });
    envLogger.debug?.("env debug line");
    await flushLogs();

    expect(readLog(dir)).toContain("[DEBUG] env debug line");
  });
});
