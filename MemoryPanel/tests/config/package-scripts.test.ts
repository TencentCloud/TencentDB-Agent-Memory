import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const panelRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(
  readFileSync(resolve(panelRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const envExample = readFileSync(resolve(panelRoot, ".env.example"), "utf8");

describe("MemoryPanel E2E package scripts", () => {
  it("maps public E2E commands to the checked-in authz scripts", () => {
    expect(packageJson.scripts["test:knowledge:e2e"]).toBe(
      "bash scripts/e2e-knowledge-authz.sh",
    );
    expect(packageJson.scripts["test:skill:e2e"]).toBe(
      "bash scripts/e2e-skill-authz.sh",
    );
    expect(packageJson.scripts["test:panel:e2e"]).toBe(
      "npm run test:knowledge:e2e && npm run test:skill:e2e",
    );
    expect(packageJson.scripts["test:knowledge:e2e:full"]).toBeUndefined();
  });

  it("keeps both E2E shell entrypoints executable", () => {
    for (const relativePath of [
      "scripts/e2e-knowledge-authz.sh",
      "scripts/e2e-skill-authz.sh",
    ]) {
      expect(() =>
        accessSync(resolve(panelRoot, relativePath), constants.X_OK),
      ).not.toThrow();
    }
  });

  it("documents the public aggregate command instead of a removed script", () => {
    expect(envExample).toContain("Panel E2E：pnpm test:panel:e2e");
    expect(envExample).not.toContain("tests/panel/e2e-panel-meta.sh");
  });
});
