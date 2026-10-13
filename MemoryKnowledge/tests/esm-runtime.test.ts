import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("imports native OKF in an actual Node ESM process", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "tests/esm-smoke.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("WikiService ESM Smoke Test Passed");
});
