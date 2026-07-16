import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runPostinstall } from "../scripts/postinstall.mjs";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux",
    env: {},
    exists: vi.fn(() => true),
    spawn: vi.fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 }),
    logger: vi.fn(),
    directory: path.join("fixture", "scripts"),
    ...overrides,
  };
}

describe("postinstall", () => {
  it("skips the Bash-only patch on Windows", () => {
    const context = createContext({ platform: "win32" });

    expect(runPostinstall(context)).toBe(0);
    expect(context.exists).not.toHaveBeenCalled();
    expect(context.spawn).not.toHaveBeenCalled();
    expect(context.logger).toHaveBeenCalledWith(
      expect.stringContaining("Windows detected; skipping OpenClaw patch"),
    );
  });

  it("skips the patch on unsupported platforms", () => {
    const context = createContext({ platform: "freebsd" });

    expect(runPostinstall(context)).toBe(0);
    expect(context.spawn).not.toHaveBeenCalled();
    expect(context.logger).toHaveBeenCalledWith(
      expect.stringContaining("unsupported platform freebsd"),
    );
  });

  it.each([
    ["explicit skip flag", { MEMORY_TENCENTDB_SKIP_OPENCLAW_PATCH: "yes" }],
    ["Hermes mode", { MEMORY_TENCENTDB_MODE: "hermes" }],
    ["Hermes home", { HERMES_HOME: "/tmp/hermes" }],
    ["Hermes agent directory", { HERMES_AGENT_DIR: "/tmp/hermes-agent" }],
  ])("skips the patch in %s", (_name, env) => {
    const context = createContext({ env });

    expect(runPostinstall(context)).toBe(0);
    expect(context.spawn).not.toHaveBeenCalled();
    expect(context.logger).toHaveBeenCalledWith(
      expect.stringContaining("Hermes install context detected"),
    );
  });

  it("skips when the patch script is not packaged", () => {
    const context = createContext({ exists: vi.fn(() => false) });

    expect(runPostinstall(context)).toBe(0);
    expect(context.spawn).not.toHaveBeenCalled();
    expect(context.logger).toHaveBeenCalledWith(
      expect.stringContaining("patch script not found"),
    );
  });

  it.each([
    [{ error: new Error("ENOENT") }],
    [{ status: 127 }],
  ])("skips when Bash is unavailable (%j)", (bashResult) => {
    const context = createContext({ spawn: vi.fn(() => bashResult) });

    expect(runPostinstall(context)).toBe(0);
    expect(context.spawn).toHaveBeenCalledTimes(1);
    expect(context.logger).toHaveBeenCalledWith(
      expect.stringContaining("bash not found"),
    );
  });

  it.each(["linux", "darwin"])("runs the patch on %s", (platform) => {
    const env = { PATH: "/usr/bin" };
    const context = createContext({ platform, env });

    expect(runPostinstall(context)).toBe(0);
    expect(context.spawn).toHaveBeenNthCalledWith(1, "bash", ["--version"], {
      stdio: "ignore",
    });
    expect(context.spawn).toHaveBeenNthCalledWith(
      2,
      "bash",
      [path.join("fixture", "scripts", "openclaw-after-tool-call-messages.patch.sh")],
      {
        cwd: "fixture",
        env,
        stdio: "inherit",
      },
    );
  });

  it.each([
    [{ error: new Error("spawn failed") }, "patch could not start"],
    [{ status: 2 }, "patch exited with status 2"],
  ])("does not fail npm install when the patch fails", (patchResult, message) => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce(patchResult);
    const context = createContext({ spawn });

    expect(runPostinstall(context)).toBe(0);
    expect(context.logger).toHaveBeenCalledWith(expect.stringContaining(message));
  });
});
