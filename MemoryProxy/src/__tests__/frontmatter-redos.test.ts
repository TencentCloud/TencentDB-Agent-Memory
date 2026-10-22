import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../common/user-query-extractor.js";

const sourceModuleUrl = pathToFileURL(
  fileURLToPath(new URL("../common/user-query-extractor.ts", import.meta.url)),
).href;

function extractorProcessInput(input: string) {
  const script = `
    import { extractUserQueryText } from ${JSON.stringify(sourceModuleUrl)};
    process.stdout.write(extractUserQueryText(process.env.TEST_INPUT));
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        TEST_INPUT: input,
      },
    },
  );
}

describe("frontmatter extraction safety", () => {
  it("still removes a complete MEMORY.md-style frontmatter block", () => {
    const raw = [
      "Before",
      "---",
      "name: demo",
      "description: Example",
      "metadata: {}",
      "---",
      "After",
    ].join("\n");

    expect(extractUserQueryText(raw)).toBe("Before\nAfter");
  });

  it("still removes complete frontmatter when the input uses CRLF", () => {
    const raw = [
      "Before",
      "---",
      "name: demo",
      "description: Example",
      "---",
      "After",
    ].join("\r\n");

    const extracted = extractUserQueryText(raw);

    expect(extracted).toContain("Before");
    expect(extracted).toContain("After");
    expect(extracted).not.toContain("description:");
  });

  it("does not catastrophically backtrack on aligned unterminated keys", () => {
    const input = [
      "check this",
      "---",
      ...Array.from(
        { length: 12 },
        (_, index) => `Key${index}:        value${index}`,
      ),
      "",
    ].join("\n");

    const result = extractorProcessInput(input);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check this");
  });
});
