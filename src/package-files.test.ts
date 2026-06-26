import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

type PackageJson = {
  files?: string[];
};

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

describe("package files", () => {
  it("keeps Hermes runtime while excluding Python cache and tests", () => {
    expect(packageJson.files).toContain("hermes-plugin/");
    expect(packageJson.files).toContain("!hermes-plugin/**/__pycache__/**");
    expect(packageJson.files).toContain("!hermes-plugin/**/*.pyc");
    expect(packageJson.files).toContain("!hermes-plugin/**/tests/**");
  });
});
