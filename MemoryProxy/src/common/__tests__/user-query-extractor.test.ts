import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../user-query-extractor.js";

describe("MEMORY.md frontmatter", () => {
  it.each(["name", "description", "metadata", "node_type", "originSessionId", "NAME"])(
    "strips a bounded block containing %s",
    (key) => {
      expect(extractUserQueryText(`before\n---\nfoo: value\n${key}: memory\n  nested: value\n---\nafter`))
        .toBe("before\nafter");
    },
  );

  it("preserves blocks with no memory key", () => {
    const text = "before\n---\nfoo: value\nbar: value\n---\nafter";
    expect(extractUserQueryText(text)).toBe(text);
  });

  it("preserves horizontal rules around ordinary prose", () => {
    const text = "before\n---\nordinary prose\nname: user text\n---\nafter";
    expect(extractUserQueryText(text)).toBe(text);
  });

  it("preserves an unterminated block", () => {
    const text = "---\nname: memory\nuser text";
    expect(extractUserQueryText(text)).toBe(text);
  });

  it("handles CRLF and multiple blocks while retaining user text", () => {
    const text = "---\r\nname: first\r\n---\r\nuser text\r\n---\r\ndescription: second\r\n---";
    expect(extractUserQueryText(text)).toBe("user text");
  });

  it.each([false, true])("bounds pathological input processing (target key: %s)", (hasTarget) => {
    // Run outside Vitest's event loop so a synchronous ReDoS cannot hang the suite.
    const input = "---\n" + "foo:\n".repeat(50_000)
      + (hasTarget ? "name: memory\n" : "") + "---\nquestion";
    const moduleUrl = new URL("../user-query-extractor.ts", import.meta.url).href;
    const script = `
      import { readFileSync } from "node:fs";
      import { extractUserQueryText } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(extractUserQueryText(readFileSync(0, "utf8")));
    `;
    const output = execFileSync(process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      { input, encoding: "utf8", timeout: 3_000, maxBuffer: 2_000_000 });
    expect(output).toBe(hasTarget ? "question" : input);
  });
});
