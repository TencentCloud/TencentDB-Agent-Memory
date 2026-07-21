import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawStateDir } from "./openclaw-state-dir.js";

describe("resolveOpenClawStateDir", () => {
  const originalEnv = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  it("uses runtime state dir when available", () => {
    process.env.OPENCLAW_STATE_DIR = "/env/state";

    const stateDir = resolveOpenClawStateDir({
      resolveStateDir: () => " /runtime/state ",
    });

    expect(stateDir).toBe("/runtime/state");
  });

  it("falls back to OPENCLAW_STATE_DIR when runtime state is missing", () => {
    process.env.OPENCLAW_STATE_DIR = " /env/state ";

    expect(resolveOpenClawStateDir(undefined)).toBe("/env/state");
  });

  it("falls back to OPENCLAW_STATE_DIR when runtime resolver throws", () => {
    process.env.OPENCLAW_STATE_DIR = "/env/state";

    const stateDir = resolveOpenClawStateDir({
      resolveStateDir: () => {
        throw new Error("state not initialized");
      },
    });

    expect(stateDir).toBe("/env/state");
  });

  it("falls back to the default OpenClaw state dir when no source is available", () => {
    delete process.env.OPENCLAW_STATE_DIR;

    expect(resolveOpenClawStateDir(undefined)).toBe(path.join(homedir(), ".openclaw"));
  });
});
