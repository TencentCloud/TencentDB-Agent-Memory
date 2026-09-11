import { describe, expect, it, vi } from "vitest";
import { runPostinstall } from "../scripts/postinstall.mjs";

function spawnOk() {
  return { status: 0, error: undefined };
}

describe("postinstall OpenClaw patch", () => {
  it("does not patch OpenClaw unless explicitly opted in", () => {
    const spawn = vi.fn(spawnOk);
    const logger = vi.fn();

    runPostinstall({
      platform: "linux",
      env: {},
      exists: () => true,
      spawn,
      logger,
      directory: "/repo/scripts",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("requires MEMORY_TENCENTDB_APPLY_OPENCLAW_PATCH=1"));
  });

  it("runs the OpenClaw patch when explicitly opted in", () => {
    const spawn = vi.fn(spawnOk);

    runPostinstall({
      platform: "linux",
      env: { MEMORY_TENCENTDB_APPLY_OPENCLAW_PATCH: "1" },
      exists: () => true,
      spawn,
      logger: vi.fn(),
      directory: "/repo/scripts",
    });

    expect(spawn).toHaveBeenCalledWith("bash", ["--version"], { stdio: "ignore" });
    expect(spawn).toHaveBeenCalledWith("bash", ["/repo/scripts/openclaw-after-tool-call-messages.patch.sh"], {
      cwd: "/repo",
      env: { MEMORY_TENCENTDB_APPLY_OPENCLAW_PATCH: "1" },
      stdio: "inherit",
    });
  });
});
