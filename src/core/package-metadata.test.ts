import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

const repoRoot = resolve(import.meta.dirname, "../..");

describe("npm package metadata", () => {
  it("does not reference missing command-line binaries", () => {
    for (const target of Object.values(packageJson.bin ?? {})) {
      expect(existsSync(resolve(repoRoot, target))).toBe(true);
    }
  });

  it("builds the publishable runtime without missing script tsconfigs", () => {
    expect(packageJson.scripts.build).toBe("npm run build:plugin");
    expect(packageJson.scripts["build:scripts"]).toBeUndefined();
  });

  it("publishes compiled runtime artifacts instead of duplicating source", () => {
    expect(packageJson.files).toContain("dist/");
    expect(packageJson.files).not.toContain("src/");
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.mjs"]);
  });
});
