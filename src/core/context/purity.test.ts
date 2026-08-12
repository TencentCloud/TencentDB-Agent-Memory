/**
 * tz-10 acceptance 6: "Assembly domain не импортирует fs/network/db/time/global
 * state". Checked, not declared: every non-test file of the domain is read and
 * scanned, so a new file joins the rule automatically.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOMAIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** What a pure assembly core may never reach for. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /from\s+"node:(fs|http|https|net|child_process|sqlite)/,
    why: "IO module",
  },
  { pattern: /from\s+"\.\.\/store\//, why: "the store" },
  { pattern: /from\s+"\.\.\/\.\.\/gateway\//, why: "the transport layer" },
  { pattern: /Date\.now\(/, why: "the clock" },
  { pattern: /new Date\(/, why: "the clock" },
  { pattern: /Math\.random\(/, why: "randomness" },
  { pattern: /^(let|var)\s/m, why: "module-level mutable state" },
];

describe("the assembler stays a pure core", () => {
  const files = fs
    .readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("has files to check at all", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} touches nothing impure`, () => {
      const source = fs.readFileSync(path.join(DOMAIN_DIR, file), "utf-8");
      for (const { pattern, why } of FORBIDDEN) {
        expect(
          pattern.test(source),
          `${file} reaches for ${why} (${pattern})`,
        ).toBe(false);
      }
    });
  }
});
