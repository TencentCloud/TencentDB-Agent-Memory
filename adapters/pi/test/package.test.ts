import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  pi?: { extensions?: string[] };
  files?: string[];
  peerDependencies?: Record<string, string>;
};

describe("package", () => {
  it("declares the pi extension entrypoint", () => {
    expect(pkg.pi?.extensions).toContain("./src/index.ts");
  });

  it("includes only intended runtime/documentation files", () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining(["src", "README.md", "README_CN.md", "CHANGELOG.md"]),
    );
  });

  it("constrains peer dependency versions (no wildcards)", () => {
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).not.toBe("*");
    expect(pkg.peerDependencies?.["typebox"]).not.toBe("*");
  });

  it("ships both English and Chinese READMEs", () => {
    expect(() => readFileSync(resolve(root, "README.md"), "utf8")).not.toThrow();
    expect(() => readFileSync(resolve(root, "README_CN.md"), "utf8")).not.toThrow();
  });

  it("documents the same environment variables in both languages", () => {
    const en = readFileSync(resolve(root, "README.md"), "utf8");
    const cn = readFileSync(resolve(root, "README_CN.md"), "utf8");
    const keys = [
      "TDAI_MEMORY_API_KEY",
      "TDAI_MEMORY_SERVICE_ID",
      "TDAI_MEMORY_TEAM_ID",
      "TDAI_MEMORY_AGENT_ID",
      "TDAI_MEMORY_USER_ID",
      "TDAI_MEMORY_ENDPOINT",
      "TDAI_PI_MAX_CONTEXT_CHARS",
      "TDAI_PI_MAX_CAPTURE_CHARS",
      "TDAI_PI_MAX_SKILL_BYTES",
    ];
    for (const key of keys) {
      expect(en).toContain(key);
      expect(cn).toContain(key);
    }
  });
});
